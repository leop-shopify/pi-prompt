import { randomBytes } from "node:crypto";
import { unwatchFile, watchFile, type Stats } from "node:fs";
import type {
  AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, InputEvent, ToolCallEvent, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  validateGeneratorInput, validateGeneratorSubmission,
  type DispatchablePlanGenerator, type PlanDispatchResult, type PlanGeneratorInput, type PlanGeneratorResult, type PrivateSkillContent,
} from "../plan/generator.js";
import { GENERATION_PROFILES, loadPlanLevel } from "../plan/modes.js";
import { planOutcomeFromMarkdown } from "../plan/markdown-plan.js";
import { annotationsFilePath, defaultPlanRoot, planFilePath, readPlanFile } from "../plan/session-files.js";
import {
  TeamsPlanningAdapter, detectTeamsPlanningCapability, observeTeamsEvents,
  type DelegatedPrimaryStatus, type PlanningModelInfo, type TeamsAdapterPhase,
} from "./teams-planning-adapter.js";

export const PLAN_SUBMIT_TOOL_NAME = "pi_prompt_submit_plan";
export const PLAN_MARKER_PREFIX = "[[pi-prompt:current-agent-plan:";

export type PlanningAdapterKind = "delegated" | "direct";
export type PlanningActivityPhase =
  | "capability-detected" | "primary-starting" | "primary-active" | "waiting-report" | "report-received"
  | "synthesizing" | "validating" | "recovering" | "completed" | "direct-fallback" | "paused";
export interface CurrentAgentActivityUpdate {
  readonly phase: PlanningActivityPhase;
  readonly progress?: { readonly summary: string; readonly updatedAt: string };
  readonly adapter: PlanningAdapterKind;
  readonly primaryCount: 0 | 1;
  readonly primaryStatus: DelegatedPrimaryStatus | "direct" | "completed" | "paused";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly budgetMinutes: number;
  readonly model: PlanningModelInfo;
}
export interface CurrentAgentActivity { (update: CurrentAgentActivityUpdate): void }
export interface CurrentAgentBridgeOptions {
  readonly nonceFactory: () => string;
  readonly loadLevel?: typeof loadPlanLevel;
  readonly primaryNameFactory?: () => string;
  readonly correlationFactory?: () => string;
  readonly clock?: () => Date;
  readonly planRoot?: string;
}

type RunKind = "dispatch" | "correction";
type GateState = "preparing" | "ready" | "open" | "settled" | "closed";
interface Gate {
  readonly owner: symbol;
  readonly epoch: number;
  readonly nonce: string;
  readonly input: PlanGeneratorInput;
  readonly resolve: (result: PlanGeneratorResult) => void;
  readonly activity?: CurrentAgentActivity;
  readonly adapterKind: PlanningAdapterKind;
  readonly startedAt: string;
  readonly budgetMinutes: number;
  model: PlanningModelInfo;
  state: GateState;
  dispatchRequested: boolean;
  pendingIdle?: () => boolean;
  levelMarkdown?: string;
  skills?: readonly PrivateSkillContent[];
  teams?: TeamsPlanningAdapter;
  stopReportObservation?: () => void;
  stopPlanWatch?: () => void;
  baselinePlan?: string | null;
  privateReport?: string;
  correctionFeedback?: string;
  correctionAttempts: number;
  pendingInjectedRun?: "correction";
  injectedContent?: string;
  sentRun?: RunKind;
  queuedRun?: RunKind;
  activeRun?: RunKind;
  marker?: string;
}

type BridgeAPI = Pick<ExtensionAPI, "registerTool" | "sendMessage" | "sendUserMessage" | "on" | "getActiveTools" | "getAllTools" | "events">;

export class CurrentAgentPlanBridge {
  readonly #pi: BridgeAPI;
  readonly #nonceFactory: () => string;
  readonly #loadLevel: typeof loadPlanLevel;
  readonly #primaryNameFactory: () => string;
  readonly #correlationFactory: () => string;
  readonly #clock: () => Date;
  readonly #planRoot: string;
  #epoch = 0;
  readonly #issuedNonces = new Set<string>();
  #active: Gate | null = null;
  #lastSettledNonce: string | null = null;

  constructor(pi: BridgeAPI, options: CurrentAgentBridgeOptions) {
    this.#pi = pi;
    this.#nonceFactory = options.nonceFactory;
    this.#loadLevel = options.loadLevel ?? loadPlanLevel;
    this.#primaryNameFactory = options.primaryNameFactory ?? (() => `planner-${randomToken()}`);
    this.#correlationFactory = options.correlationFactory ?? randomToken;
    this.#clock = options.clock ?? (() => new Date());
    this.#planRoot = options.planRoot ?? defaultPlanRoot();
    pi.registerTool({
      name: PLAN_SUBMIT_TOOL_NAME,
      label: "Submit plan",
      description: "Submit the one structured initial or revision plan requested by pi-prompt.",
      parameters: Type.Object({ nonce: Type.String({ minLength: 16, maxLength: 128 }), result: Type.Unknown() }, { additionalProperties: false }),
      execute: async (_toolCallId, params) => this.#executeSubmit(params.nonce, params.result),
    });
    pi.on("input", (event) => this.handleInput(event));
    pi.on("before_agent_start", (event) => this.beforeAgentStart(event));
    pi.on("message_start", (event) => this.messageStart(event));
    pi.on("tool_call", (event) => this.toolCall(event));
    pi.on("tool_result", (event) => this.toolResult(event));
    pi.on("agent_end", (event) => this.agentEnd(event));
  }

  createGenerator(isIdle: () => boolean, activity?: CurrentAgentActivity): DispatchablePlanGenerator {
    const owner = Symbol("current-agent-plan-owner");
    return {
      generate: (input) => this.#generate(owner, input, activity),
      dispatch: (jobId) => this.#dispatch(owner, jobId, isIdle),
      close: () => this.#closeOwner(owner),
    };
  }

  handleInput(event: InputEvent): void {
    const gate = this.#active;
    if (!this.#isOpen(gate) || event.source !== "extension" || event.text !== gate.marker || !gate.sentRun) return;
    gate.queuedRun = gate.sentRun;
  }

  beforeAgentStart(event: BeforeAgentStartEvent): { readonly message: { readonly customType: string; readonly content: string; readonly display: false } } | void {
    const gate = this.#active;
    if (!this.#isOpen(gate) || !gate.levelMarkdown || !gate.skills) return;
    if (event.prompt !== gate.marker || gate.queuedRun !== gate.sentRun || !gate.sentRun) return;
    const run = gate.sentRun;
    gate.activeRun = run;
    gate.sentRun = undefined;
    gate.queuedRun = undefined;
    gate.marker = undefined;
    if (run === "correction") this.#activity(gate, "recovering", gate.teams?.primaryStatus ?? "not-started");
    const content = gate.adapterKind === "direct"
      ? this.#directMessage(gate)
      : this.#orchestrationMessage(run);
    return { message: { customType: "pi-prompt-plan-request", content, display: false } };
  }

  messageStart(event: { readonly message: unknown }): void {
    const gate = this.#active;
    if (!this.#isOpen(gate) || gate.adapterKind !== "delegated" || !gate.teams) return;
    const message = asRecord(event.message);
    if (gate.pendingInjectedRun === "correction" && message?.role === "custom" && message.customType === "pi-prompt-plan-correction" && message.content === gate.injectedContent) {
      gate.pendingInjectedRun = undefined;
      gate.injectedContent = undefined;
      gate.activeRun = "correction";
      this.#activity(gate, "recovering", gate.teams.primaryStatus);
    }
  }

  toolCall(event: ToolCallEvent) {
    const gate = this.#active;
    if (!this.#isOpen(gate) || gate.adapterKind !== "delegated" || !gate.teams) return;
    return gate.teams.handleToolCall(event);
  }

  toolResult(event: ToolResultEvent): void {
    const gate = this.#active;
    if (!this.#isOpen(gate) || gate.adapterKind !== "delegated") return;
    gate.teams?.handleToolResult(event);
  }

  agentEnd(_event: AgentEndEvent): void {
    const gate = this.#active;
    if (!this.#isOpen(gate) || !gate.activeRun) return;
    const ended = gate.activeRun;
    gate.activeRun = undefined;
    if (gate.adapterKind === "direct") {
      this.#settle(gate, failed("missing-plan-submission", "The correlated current-agent run ended without submitting a plan."));
      return;
    }
    if (ended === "dispatch" || ended === "correction") {
      if (gate.teams?.primaryStatus === "waiting" || gate.privateReport !== undefined) {
        if (gate.privateReport === undefined) this.#activity(gate, "waiting-report", "waiting");
        return;
      }
      if (ended === "correction" && gate.correctionFeedback) {
        this.#injectCorrection(gate);
        return;
      }
      this.#settle(gate, failed("delegation-not-started", "The mandatory primary planner did not start."));
    }
  }

  async #generate(owner: symbol, input: PlanGeneratorInput, activity?: CurrentAgentActivity): Promise<PlanGeneratorResult> {
    const validated = validateGeneratorInput(input);
    if (!validated.ok) return failed("invalid-generator-input", "The plan generation input is invalid.");
    if (this.#active && !["settled", "closed"].includes(this.#active.state)) return failed("generation-active", "Another plan generation request is active.");
    const nonce = this.#nonceFactory();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || this.#issuedNonces.has(nonce)) return failed("invalid-nonce", "The plan submission nonce could not be created.");
    this.#issuedNonces.add(nonce);
    const profile = GENERATION_PROFILES[input.session.generation.mode];
    const adapterKind: PlanningAdapterKind = detectTeamsPlanningCapability(this.#pi, profile.modelSlot) ? "delegated" : "direct";
    let resolve!: (result: PlanGeneratorResult) => void;
    const completion = new Promise<PlanGeneratorResult>((done) => { resolve = done; });
    const gate: Gate = {
      owner, epoch: ++this.#epoch, nonce, input, resolve, activity, adapterKind,
      startedAt: this.#clock().toISOString(), budgetMinutes: profile.timeBudgetMinutes, model: { slot: profile.modelSlot },
      state: "preparing", dispatchRequested: false, correctionAttempts: 0,
    };
    this.#active = gate;
    if (adapterKind === "delegated" && !this.#configureTeams(gate)) return completion;
    this.#activity(gate, adapterKind === "delegated" ? "capability-detected" : "direct-fallback", adapterKind === "delegated" ? "not-started" : "direct");
    input.signal.addEventListener("abort", () => this.#closeGate(gate), { once: true });
    void this.#prepare(gate);
    return completion;
  }

  #configureTeams(gate: Gate): boolean {
    const primaryName = this.#primaryNameFactory();
    const correlation = this.#correlationFactory();
    if (!/^planner-[A-Za-z0-9_-]{8,80}$/u.test(primaryName) || !/^[A-Za-z0-9_-]{8,128}$/u.test(correlation)) {
      this.#settle(gate, failed("delegation-identity-unavailable", "The private primary planner identity could not be created."));
      return false;
    }
    const adapter = new TeamsPlanningAdapter({
      primaryName, correlation, cwd: gate.input.session.source.cwd,
      mission: "pending-controller-mission",
      modelSlot: GENERATION_PROFILES[gate.input.session.generation.mode].modelSlot,
      submitToolName: PLAN_SUBMIT_TOOL_NAME,
      onPhase: (phase) => this.#teamsPhase(gate, phase),
      onReport: (report) => { void this.#primaryReport(gate, report); },
      onProgress: (status, updatedAt) => this.#primaryProgress(gate, status, updatedAt),
      onModel: (model) => { gate.model = model; this.#activity(gate, "primary-active", gate.teams?.primaryStatus ?? "active"); },
      now: () => this.#clock().getTime(),
    });
    gate.teams = adapter;
    gate.stopReportObservation = observeTeamsEvents(this.#pi.events, adapter);
    return true;
  }

  async #prepare(gate: Gate): Promise<void> {
    try {
      const [levelMarkdown, loaded] = await Promise.all([this.#loadLevel(gate.input.session.generation.mode), gate.input.loadSkills()]);
      if (this.#active !== gate || gate.state === "closed" || gate.state === "settled") return;
      if (!loaded.ok) { this.#settle(gate, failed("skill-context-changed", "Private skill context changed during generation.")); return; }
      gate.levelMarkdown = levelMarkdown;
      gate.skills = loaded.value;
      try { gate.baselinePlan = await readPlanFile(this.#planRoot, gate.input.session.id); }
      catch { gate.baselinePlan = null; }
      this.#watchPlanFile(gate);
      if (gate.teams && !gate.teams.setMission(this.#childMission(gate))) {
        this.#settle(gate, failed("delegation-mission-unavailable", "The private primary planner mission could not be prepared."));
        return;
      }
      gate.state = "ready";
      if (gate.dispatchRequested) this.#sendRun(gate, "dispatch");
    } catch {
      if (this.#active === gate) this.#settle(gate, failed("plan-level-unavailable", "The selected planning level could not be loaded."));
    }
  }


  #dispatch(owner: symbol, jobId: string, isIdle: () => boolean): PlanDispatchResult {
    const gate = this.#active;
    if (!gate || gate.owner !== owner || gate.input.jobId !== jobId || gate.state === "closed" || gate.state === "settled") return dispatchFailed("stale-generation-job", "The generation job is no longer active.");
    if (gate.dispatchRequested) return dispatchFailed("duplicate-dispatch", "The generation job was already dispatched.");
    gate.dispatchRequested = true;
    gate.pendingIdle = isIdle;
    if (gate.state === "ready") this.#sendRun(gate, "dispatch");
    return { ok: true, value: undefined };
  }

  #sendRun(gate: Gate, run: RunKind): void {
    if (!this.#isOpen(gate) || gate.sentRun || gate.queuedRun) return;
    const marker = `${PLAN_MARKER_PREFIX}${gate.nonce}:${run}:${gate.epoch}]]`;
    gate.sentRun = run;
    gate.marker = marker;
    gate.state = "open";
    try {
      if (gate.pendingIdle?.() ?? true) this.#pi.sendUserMessage(marker);
      else this.#pi.sendUserMessage(marker, { deliverAs: "followUp" });
    } catch {
      this.#settle(gate, failed("dispatch-failed", "The planning request could not be sent to the current agent."));
    }
  }

  #injectCorrection(gate: Gate): void {
    if (!this.#isOpen(gate) || gate.pendingInjectedRun || gate.activeRun) return;
    const content = [
      "The saved Markdown plan needs one correction pass.",
      "Call spawn_agent exactly once now. The adapter will replace every argument with the private writer mission.",
      "Do not inspect files, rewrite the plan yourself, or call any other tool.",
    ].join("\n\n");
    gate.pendingInjectedRun = "correction";
    gate.injectedContent = content;
    try {
      this.#pi.sendMessage(
        { customType: "pi-prompt-plan-correction", content, display: false },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      this.#settle(gate, failed("dispatch-failed", "The correction continuation could not be delivered."));
    }
  }

  async #executeSubmit(nonce: string, result: unknown) {
    const gate = this.#active;
    if (!gate || nonce !== gate.nonce) {
      const code = nonce === this.#lastSettledNonce ? "duplicate-submission" : "stale-submission";
      return toolFailure(code, "This plan submission is not active.");
    }
    if (gate.state === "settled") return toolFailure("duplicate-submission", "This plan was already submitted.");
    if (!this.#isOpen(gate) || !gate.skills || !this.#submissionRunActive(gate)) return toolFailure("submission-not-started", "The correlated synthesis run has not begun.");
    this.#activity(gate, "validating", gate.teams?.primaryStatus ?? "direct");
    let validated: PlanGeneratorResult;
    if (result === "plan saved") {
      try {
        const markdown = await readPlanFile(this.#planRoot, gate.input.session.id);
        const parsed = planOutcomeFromMarkdown(markdown, gate.input.operation, gate.input.session, gate.input.selectedAnnotationIds);
        validated = parsed.ok
          ? validateGeneratorSubmission(parsed.value, gate.input.operation, gate.input.session, gate.skills)
          : failed("invalid-plan-file", parsed.issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join("; "));
      } catch { validated = failed("missing-plan-file", "The plan.md file was not saved correctly."); }
    } else validated = validateGeneratorSubmission(result, gate.input.operation, gate.input.session, gate.skills);
    if (!validated.ok) {
      this.#activity(gate, gate.adapterKind === "delegated" ? "synthesizing" : "direct-fallback", gate.teams?.primaryStatus ?? "direct");
      return toolFailure(validated.error.code, validated.error.message);
    }
    this.#activity(gate, "completed", "completed");
    this.#settle(gate, validated, false);
    return { content: [{ type: "text" as const, text: "Plan accepted for durable controller validation and browser review." }], details: { code: "accepted", accepted: true } };
  }

  #submissionRunActive(gate: Gate): boolean {
    return gate.adapterKind === "direct" && gate.activeRun === "dispatch";
  }

  #teamsPhase(gate: Gate, phase: TeamsAdapterPhase): void {
    if (!this.#isOpen(gate)) return;
    this.#activity(gate, phase, gate.teams?.primaryStatus ?? "not-started");
  }

  #primaryProgress(gate: Gate, summary: string, updatedAt: number): void {
    if (!this.#isOpen(gate) || gate.privateReport !== undefined || !gate.teams) return;
    this.#activity(gate, "waiting-report", gate.teams.primaryStatus, { summary, updatedAt: new Date(updatedAt).toISOString() });
  }

  #watchPlanFile(gate: Gate): void {
    const path = planFilePath(this.#planRoot, gate.input.session.id);
    let reading = false;
    const inspect = async (): Promise<void> => {
      if (reading || !this.#isOpen(gate) || !gate.skills) return;
      reading = true;
      try {
        const markdown = await readPlanFile(this.#planRoot, gate.input.session.id);
        if (!this.#isOpen(gate) || markdown === gate.baselinePlan) return;
        const parsed = planOutcomeFromMarkdown(markdown, gate.input.operation, gate.input.session, gate.input.selectedAnnotationIds);
        if (!parsed.ok) return;
        const validated = validateGeneratorSubmission(parsed.value, gate.input.operation, gate.input.session, gate.skills);
        if (!validated.ok) return;
        this.#activity(gate, "completed", "completed");
        this.#settle(gate, validated, false);
      } catch { /* the writer may still be creating or replacing plan.md */ }
      finally { reading = false; }
    };
    const changed = (current: Stats, previous: Stats): void => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) void inspect();
    };
    watchFile(path, { interval: 250, persistent: false }, changed);
    gate.stopPlanWatch = () => unwatchFile(path, changed);
  }

  async #primaryReport(gate: Gate, report: string): Promise<void> {
    if (!this.#isOpen(gate) || gate.privateReport !== undefined || !gate.skills) return;
    gate.privateReport = report;
    this.#activity(gate, "validating", "report-received");
    let validationError: string | undefined;
    if (report.trim() !== "plan saved") validationError = "The writer must report exactly `plan saved`.";
    let validated: PlanGeneratorResult | undefined;
    if (!validationError) {
      try {
        const markdown = await readPlanFile(this.#planRoot, gate.input.session.id);
        if (!this.#isOpen(gate)) return;
        const parsed = planOutcomeFromMarkdown(markdown, gate.input.operation, gate.input.session, gate.input.selectedAnnotationIds);
        validated = parsed.ok
          ? validateGeneratorSubmission(parsed.value, gate.input.operation, gate.input.session, gate.skills)
          : failed("invalid-plan-file", parsed.issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join("; "));
      } catch {
        validated = failed("missing-plan-file", "The writer did not save a readable plan.md file.");
      }
    }
    if (validated?.ok) {
      this.#activity(gate, "completed", "completed");
      this.#settle(gate, validated, false);
      return;
    }
    gate.correctionFeedback = validationError ?? validated?.error.message ?? "The saved plan is invalid.";
    if (gate.correctionAttempts >= 1) {
      this.#settle(gate, failed("invalid-plan-file", "The writer could not save a valid plan. The saved request can be retried."));
      return;
    }
    gate.correctionAttempts += 1;
    const mission = this.#correctionMission(gate);
    if (!gate.teams?.prepareRetry(mission)) {
      this.#settle(gate, failed("correction-unavailable", "The saved plan could not be corrected safely. The request can be retried."));
      return;
    }
    gate.privateReport = undefined;
    this.#activity(gate, "recovering", "not-started");
    this.#injectCorrection(gate);
  }

  #activity(
    gate: Gate,
    phase: PlanningActivityPhase,
    primaryStatus: CurrentAgentActivityUpdate["primaryStatus"],
    progress?: CurrentAgentActivityUpdate["progress"],
  ): void {
    gate.activity?.({
      phase, ...(progress ? { progress } : {}), adapter: gate.adapterKind,
      primaryCount: gate.teams?.primaryCount === 1 ? 1 : 0, primaryStatus,
      startedAt: gate.startedAt, updatedAt: this.#clock().toISOString(), budgetMinutes: gate.budgetMinutes, model: gate.model,
    });
  }

  #settle(gate: Gate, result: PlanGeneratorResult, emit = true): void {
    if (gate.state === "settled" || gate.state === "closed") return;
    gate.state = "settled";
    if (result.ok) this.#lastSettledNonce = gate.nonce;
    if (emit) this.#activity(gate, result.ok ? "completed" : result.error.code === "delegated-planning-paused" ? "paused" : gate.adapterKind === "direct" ? "direct-fallback" : "paused", result.ok ? "completed" : "paused");
    this.#closeObservation(gate);
    gate.resolve(result);
  }
  #closeOwner(owner: symbol): void { const gate = this.#active; if (gate?.owner === owner) this.#closeGate(gate); }
  #closeGate(gate: Gate): void {
    if (gate.state === "closed" || gate.state === "settled") return;
    gate.state = "closed";
    this.#closeObservation(gate);
    gate.resolve(failed("generation-cancelled", "Plan generation was cancelled."));
  }
  #closeObservation(gate: Gate): void {
    gate.stopPlanWatch?.(); gate.stopPlanWatch = undefined;
    gate.stopReportObservation?.(); gate.stopReportObservation = undefined;
    gate.teams?.close();
  }
  #isOpen(gate: Gate | null): gate is Gate { return Boolean(gate && gate.state !== "closed" && gate.state !== "settled"); }

  #orchestrationMessage(run: RunKind): string {
    return [
      "Pi Prompt detected a validated active pi-extended-teams capability. Delegation is mandatory for this plan.",
      `You are orchestration-only. Call spawn_agent exactly once now. The adapter will replace all arguments with the private ${run === "correction" ? "correction" : "primary-planner"} mission.`,
      "Do not inspect the repository, call any other tool, spawn a swarm or helper, or attempt the plan yourself. After the one spawn call succeeds, end this run and wait for the report.",
    ].join("\n\n");
  }

  #directMessage(gate: Gate): string {
    if (gate.input.operation === "revision") {
      const selected = new Set(gate.input.selectedAnnotationIds);
      const notes = gate.input.session.annotations.filter((annotation) => selected.has(annotation.id));
      return [
        "## Controller-owned revision mission", `Submission nonce: ${gate.nonce}`,
        `Current plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
        `Notes file path: ${annotationsFilePath(this.#planRoot, gate.input.session.id)}`,
        `Selected notes: ${JSON.stringify(notes)}`,
        ...(gate.input.instruction ? [`Additional revision instruction: ${gate.input.instruction}`] : []),
        "Read the current plan and notes. Apply only the selected feedback, preserve everything else, and rewrite only plan.md.",
        "Then call pi_prompt_submit_plan exactly once with `result` equal to the string `plan saved`.",
      ].join("\n\n");
    }
    return [gate.levelMarkdown!, "\n## Controller-owned plan-file request\n", `Submission nonce: ${gate.nonce}`,
      this.#controllerContext(gate),
      `Write the complete Markdown plan to exactly: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      "The file must have one `#` title, exactly one `## Execution`, and `## Implementation Tasks` with `###` tasks containing `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:` lines.",
      "Then call pi_prompt_submit_plan exactly once with `result` equal to the string `plan saved`.",
    ].join("\n\n");
  }

  #childMission(gate: Gate): string {
    if (gate.input.operation === "revision") return this.#revisionMission(gate);
    return [
      gate.levelMarkdown!, "\n## Controller-owned primary planning mission\n",
      "You are the one plan writer. Handle this planning task alone; helpers and swarms are unsupported.",
      "Inspect repository evidence as needed, but do not implement the requested work, install anything, start services, commit, push, deploy, or modify any file except the exact plan.md path below.",
      "Call report_progress with one concise, user-safe summary whenever your meaningful planning focus changes. Describe the work, not private chain-of-thought, tools, paths, or hidden instructions.",
      `Write the complete Markdown plan to exactly: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      "The file must have one `#` title, exactly one `## Execution` section, and `## Implementation Tasks` with one or more `###` tasks. Every task body must include lines starting `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:`.",
      "Finish by calling report_and_exit with both `content` and `summary` equal to exactly `plan saved`. Do not put the plan in the report.",
      "Do not call pi_prompt_submit_plan. Pi Prompt reads and validates plan.md directly.",
      this.#controllerContext(gate),
    ].join("\n\n");
  }

  #revisionMission(gate: Gate): string {
    const selected = new Set(gate.input.selectedAnnotationIds);
    const notes = gate.input.session.annotations.filter((annotation) => selected.has(annotation.id));
    return [
      "## Controller-owned revision mission",
      "You are revising the existing plan, not creating a new plan.",
      `Current plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      `Notes file path: ${annotationsFilePath(this.#planRoot, gate.input.session.id)}`,
      `Selected notes: ${JSON.stringify(notes)}`,
      ...(gate.input.instruction ? [`Additional revision instruction: ${gate.input.instruction}`] : []),
      "Read the current plan from its path and read the notes file. Apply the selected notes and additional instruction only. Preserve every unmentioned section, task, constraint, and decision.",
      "Rewrite only the current plan path. Do not modify annotations.json or any repository file.",
      "Keep one `#` title, exactly one `## Execution`, and `## Implementation Tasks` with `###` tasks containing `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:` lines.",
      "Call report_progress with one concise, user-safe summary of the revision.",
      "Finish by calling report_and_exit with both `content` and `summary` equal to exactly `plan saved`.",
    ].join("\n\n");
  }

  #correctionMission(gate: Gate): string {
    return [
      "## Saved plan correction",
      `Plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      ...(gate.input.operation === "revision" ? [`Notes path: ${annotationsFilePath(this.#planRoot, gate.input.session.id)}`] : []),
      `Validation feedback: ${gate.correctionFeedback ?? "The saved plan was invalid."}`,
      "Read the current plan first. Fix only the validation problem and preserve all other content. Rewrite only plan.md; do not modify annotations.json or repository files.",
      "Keep one `#` title, exactly one `## Execution`, and `## Implementation Tasks` with `###` tasks containing `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:` lines.",
      "Call report_progress once with a concise, user-safe summary of the correction.",
      "Finish by calling report_and_exit with both `content` and `summary` equal to exactly `plan saved`.",
    ].join("\n\n");
  }

  #controllerContext(gate: Gate): string {
    return [
      `Original request:\n${gate.input.session.source.prompt}`,
      `Working directory:\n${gate.input.session.source.cwd}`,
      `Execution kind:\n${gate.input.session.execution.kind}`,
      `Plan file:\n${planFilePath(this.#planRoot, gate.input.session.id)}`,
      `Selected feedback IDs:\n${JSON.stringify(gate.input.selectedAnnotationIds)}`,
      `Feedback from annotations.json:\n${JSON.stringify(gate.input.session.annotations)}`,
      ...(gate.input.instruction === undefined ? [] : [`Revision instruction:\n${gate.input.instruction}`]),
      `Selected private skill context (never copy private instructions or paths into the result):\n${JSON.stringify(gate.skills)}`,
    ].join("\n\n");
  }
}

function randomToken(): string { return randomBytes(18).toString("base64url"); }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function failed(code: string, message: string): PlanGeneratorResult { return { ok: false, error: { code, message } }; }
function dispatchFailed(code: string, message: string): PlanDispatchResult { return { ok: false, error: { code, message } }; }
function toolFailure(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `${code}: ${message}` }], details: { code, accepted: false }, isError: true };
}
