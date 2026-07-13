import { randomBytes } from "node:crypto";
import type {
  AgentEndEvent, BeforeAgentStartEvent, ExtensionAPI, InputEvent, ToolCallEvent, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  validateClarificationSubmission, validateGeneratorInput, validateGeneratorSubmission, validateGrillSubmission, validateRevisionMarkdownPrivacy,
  type DispatchablePlanGenerator, type PlanDispatchResult, type PlanGeneratorInput, type PlanGeneratorResult,
  type PrivateSkillContent, type WriterSubmissionInput,
} from "../plan/generator.js";
import { GENERATION_PROFILES, loadPlanLevel } from "../plan/modes.js";
import { planOutcomeFromMarkdown } from "../plan/markdown-plan.js";
import { parseStrictJsonObject } from "../plan/raw-json.js";
import { MAX_GRILL_RESULT_BYTES, MAX_WRITER_RESULT_BYTES, annotationsFilePath, defaultPlanRoot, planFilePath, writerGrillFilePath, writerQuestionsFilePath } from "../plan/session-files.js";
import type { DispatchableSpecGenerator, SpecGeneratorInput, SpecGeneratorResult, SpecWriterSubmission } from "../spec/generator.js";
import { specResultFromBytes, validateSpecGeneratorInput } from "../spec/generator.js";
import { specFilePath, writerSpecResultFilePath } from "../spec/session-files.js";
import {
  TeamsPlanningAdapter, detectTeamsPlanningCapability, observeTeamsEvents,
  type DelegatedPrimaryStatus, type PlanningModelInfo, type TeamsAdapterPhase,
} from "./teams-planning-adapter.js";

export const PLAN_SUBMIT_TOOL_NAME = "pi_prompt_submit_plan";
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
  readonly attemptFactory?: () => string;
  readonly clock?: () => Date;
  readonly planRoot?: string;
}

type RunKind = "dispatch" | "correction";
type GateState = "preparing" | "ready" | "open" | "settled" | "closed";
interface SpecGate {
  readonly owner: symbol;
  readonly input: SpecGeneratorInput;
  readonly resolve: (result: SpecGeneratorResult) => void;
  readonly attemptId: string;
  writerEndpoint?: string;
  latestValidationError?: { readonly code: string; readonly message: string };
  marker?: string;
  state: "preparing" | "ready" | "open" | "settled" | "closed";
  dispatchRequested: boolean;
  queued: boolean;
  active: boolean;
  isIdle?: () => boolean;
}
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
  privateReport?: string;
  correctionFeedback?: string;
  correctionAttempts: number;
  pendingInjectedRun?: "correction";
  injectedContent?: string;
  sentRun?: RunKind;
  queuedRun?: RunKind;
  activeRun?: RunKind;
  activeAttempt: string;
  writerEndpoint?: string;
  marker?: string;
}
type BridgeAPI = Pick<ExtensionAPI, "registerTool" | "sendMessage" | "sendUserMessage" | "on" | "getActiveTools" | "getAllTools" | "events">;

export class CurrentAgentPlanBridge {
  readonly #pi: BridgeAPI;
  readonly #nonceFactory: () => string;
  readonly #loadLevel: typeof loadPlanLevel;
  readonly #primaryNameFactory: () => string;
  readonly #correlationFactory: () => string;
  readonly #attemptFactory: () => string;
  readonly #clock: () => Date;
  readonly #planRoot: string;
  #epoch = 0;
  readonly #issuedNonces = new Set<string>();
  readonly #issuedAttempts = new Set<string>();
  readonly #verbosePlanSessions = new Set<string>();
  #active: Gate | null = null;
  #activeSpec: SpecGate | null = null;

  constructor(pi: BridgeAPI, options: CurrentAgentBridgeOptions) {
    this.#pi = pi;
    this.#nonceFactory = options.nonceFactory;
    this.#loadLevel = options.loadLevel ?? loadPlanLevel;
    this.#primaryNameFactory = options.primaryNameFactory ?? (() => `planner-${randomToken()}`);
    this.#correlationFactory = options.correlationFactory ?? randomToken;
    this.#attemptFactory = options.attemptFactory ?? randomToken;
    this.#clock = options.clock ?? (() => new Date());
    this.#planRoot = options.planRoot ?? defaultPlanRoot();
    pi.registerTool({
      name: PLAN_SUBMIT_TOOL_NAME,
      label: "Submit plan",
      description: "Legacy compatibility signal. Writer results are accepted only through the authenticated private HTTP handoff.",
      parameters: Type.Object({ nonce: Type.String({ minLength: 16, maxLength: 128 }), result: Type.Unknown() }, { additionalProperties: false }),
      execute: async () => toolFailure("http-submission-required", "Submit the exact writer bytes through the private HTTP endpoint."),
    });
    pi.on("input", (event) => this.handleInput(event));
    pi.on("before_agent_start", (event) => this.beforeAgentStart(event));
    pi.on("message_start", (event) => this.messageStart(event));
    pi.on("tool_call", (event) => this.toolCall(event));
    pi.on("tool_result", (event) => this.toolResult(event));
    pi.on("agent_end", (event) => this.agentEnd(event));
  }

  createSpecGenerator(isIdle: () => boolean): DispatchableSpecGenerator {
    const owner = Symbol("current-agent-spec-owner"); let writerEndpoint: string | undefined;
    return {
      generate: (input) => this.#generateSpec(owner, input, writerEndpoint),
      configureWriterEndpoint: (url) => { const result = this.#configureSpecWriterEndpoint(owner, url); if (result.ok) writerEndpoint = url; return result; },
      submitWriterResult: (input) => this.#submitSpecWriterResult(owner, input),
      dispatch: (jobId) => this.#dispatchSpec(owner, jobId, isIdle),
      close: () => this.#closeSpecOwner(owner),
    };
  }

  createGenerator(isIdle: () => boolean, activity?: CurrentAgentActivity): DispatchablePlanGenerator {
    const owner = Symbol("current-agent-plan-owner");
    let writerEndpoint: string | undefined;
    return {
      generate: (input) => this.#generate(owner, input, activity, writerEndpoint),
      configureWriterEndpoint: (url) => {
        const configured = this.#configureWriterEndpoint(owner, url);
        if (configured.ok) writerEndpoint = url;
        return configured;
      },
      submitWriterResult: (input) => this.#submitWriterResult(owner, input),
      dispatch: (jobId) => this.#dispatch(owner, jobId, isIdle),
      close: () => this.#closeOwner(owner),
    };
  }

  handleInput(event: InputEvent): void {
    const spec = this.#activeSpec;
    if (spec && spec.state === "open" && event.source === "extension" && event.text === spec.marker) { spec.queued = true; return; }
    const gate = this.#active;
    if (!this.#isOpen(gate) || event.source !== "extension" || event.text !== gate.marker || !gate.sentRun) return;
    gate.queuedRun = gate.sentRun;
  }

  beforeAgentStart(event: BeforeAgentStartEvent): { readonly message: { readonly customType: string; readonly content: string; readonly display: false } } | void {
    const spec = this.#activeSpec;
    if (spec && spec.state === "open" && spec.queued && event.prompt === spec.marker) { spec.queued = false; spec.active = true; spec.marker = undefined; return { message: { customType: "pi-prompt-spec-request", content: this.#specMission(spec), display: false } }; }
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
      ? this.#directMessage(gate, run)
      : this.#orchestrationMessage(gate, run);
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
      gate.correctionFeedback = undefined;
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
    const spec = this.#activeSpec;
    if (spec && spec.active && !["settled", "closed"].includes(spec.state)) {
      const error = spec.latestValidationError ?? { code: "missing-spec-submission", message: "The correlated Spec writer ended without an accepted HTTP submission." };
      this.#settleSpec(spec, { ok: false, error });
      this.#sendSpecFailureFollowUp(spec.input, error);
      return;
    }
    const gate = this.#active;
    if (!this.#isOpen(gate) || !gate.activeRun) return;
    const ended = gate.activeRun;
    gate.activeRun = undefined;
    if (gate.adapterKind === "direct") {
      if (gate.correctionAttempts === 1 && gate.correctionFeedback && ended === "dispatch") {
        this.#sendRun(gate, "correction");
        return;
      }
      this.#settle(gate, failed("missing-plan-submission", "The correlated current-agent run ended without an accepted HTTP submission."));
      return;
    }
    if (ended === "dispatch" || ended === "correction") {
      if (gate.correctionFeedback && gate.correctionAttempts === 1 && gate.privateReport !== undefined) {
        this.#beginCorrection(gate);
        return;
      }
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

  async #generateSpec(owner: symbol, input: SpecGeneratorInput, writerEndpoint?: string): Promise<SpecGeneratorResult> {
    const validated = validateSpecGeneratorInput(input); if (!validated.ok) return { ok: false, error: validated.error };
    if (this.#activeSpec && !["settled", "closed"].includes(this.#activeSpec.state) || this.#active && !["settled", "closed"].includes(this.#active.state)) {
      const error = { code: "generation-active", message: "Another writer request is active." };
      this.#sendSpecFailureFollowUp(input, error); return { ok: false, error };
    }
    const attemptId = this.#nextAttempt();
    if (!attemptId) {
      const error = { code: "attempt-identity-unavailable", message: "The private Spec writer identity could not be created." };
      this.#sendSpecFailureFollowUp(input, error); return { ok: false, error };
    }
    let resolve!: (result: SpecGeneratorResult) => void; const completion = new Promise<SpecGeneratorResult>((done) => { resolve = done; });
    const gate: SpecGate = { owner, input, resolve, attemptId, ...(writerEndpoint ? { writerEndpoint } : {}), state: writerEndpoint ? "ready" : "preparing", dispatchRequested: false, queued: false, active: false };
    this.#activeSpec = gate; input.signal.addEventListener("abort", () => this.#closeSpecGate(gate), { once: true }); return completion;
  }
  #configureSpecWriterEndpoint(owner: symbol, url: string): PlanDispatchResult {
    if (!validWriterEndpoint(url)) return dispatchFailed("invalid-writer-endpoint", "The private Spec writer endpoint is invalid."); const gate = this.#activeSpec;
    if (gate?.owner === owner && !["settled", "closed"].includes(gate.state)) { if (gate.dispatchRequested && gate.writerEndpoint !== url) return dispatchFailed("writer-endpoint-locked", "The active Spec endpoint cannot be changed."); gate.writerEndpoint = url; if (gate.state === "preparing") gate.state = "ready"; if (gate.dispatchRequested) this.#sendSpecRun(gate); }
    return { ok: true, value: undefined };
  }
  #dispatchSpec(owner: symbol, jobId: string, isIdle: () => boolean): PlanDispatchResult {
    const gate = this.#activeSpec; if (!gate || gate.owner !== owner || gate.input.jobId !== jobId || ["settled", "closed"].includes(gate.state)) return dispatchFailed("stale-generation-job", "The Spec generation job is no longer active."); if (!gate.writerEndpoint) return dispatchFailed("writer-endpoint-unavailable", "The private Spec writer endpoint is not configured."); if (gate.dispatchRequested) return dispatchFailed("duplicate-dispatch", "The Spec generation job was already dispatched."); gate.dispatchRequested = true; gate.isIdle = isIdle; if (gate.state === "ready") this.#sendSpecRun(gate); return { ok: true, value: undefined };
  }
  #sendSpecRun(gate: SpecGate): void { if (["closed", "settled"].includes(gate.state) || gate.marker || gate.active) return; gate.marker = `pi-prompt Spec ${gate.input.operation === "initial" ? "creation" : "revision"} in progress`; gate.state = "open"; try { if (gate.isIdle?.() ?? true) this.#pi.sendUserMessage(gate.marker); else this.#pi.sendUserMessage(gate.marker, { deliverAs: "followUp" }); } catch { this.#settleSpec(gate, { ok: false, error: { code: "dispatch-failed", message: "The Spec writer request could not be sent." } }); } }
  async #submitSpecWriterResult(owner: symbol, input: SpecWriterSubmission): Promise<PlanDispatchResult> {
    const gate = this.#activeSpec; const job = gate?.input.session.generationJob; if (!gate || gate.owner !== owner || gate.state !== "open" || !gate.active || !job || input.kind !== "spec" || input.attemptId !== gate.attemptId || input.planSessionId !== gate.input.session.planSessionId || input.jobId !== gate.input.jobId || input.operation !== gate.input.operation || input.baseSpecRevision !== job.baseSpecRevision) return dispatchFailed("writer-attempt-rejected", "The Spec writer submission is not active.");
    const result = specResultFromBytes(input.body);
    if (!result.ok) { gate.latestValidationError = result.error; return dispatchFailed(result.error.code, result.error.message); }
    this.#settleSpec(gate, result); return { ok: true, value: undefined };
  }
  #specMission(gate: SpecGate): string {
    const source = gate.input.source.reference;
    const comments = gate.input.session.comments
      .filter((comment) => gate.input.selectedCommentIds.includes(comment.id))
      .map((comment) => ({ id: comment.id, body: comment.body, exact: comment.target.exact }));
    const canonical = specFilePath(source.planArtifactPath);
    const output = writerSpecResultFilePath(source.planArtifactPath);
    return [
      "## Controller-owned Spec writer mission", `Operation: ${gate.input.operation}`, `Plan session: ${source.planSessionId}`,
      `Plan Markdown: ${source.planMarkdownPath}`, `Plan annotations: ${source.annotationsPath}`,
      `Plan revision/state: ${source.planDocumentRevision}/${source.planStateVersion}`,
      `Grill decision tree: ${source.grillPath}${source.grillPointer}`,
      `Grill revision/state: ${source.grillBasedOnDocumentRevision}/${source.grillStateVersion}`,
      ...(gate.input.operation === "revision" ? [`Existing Spec input: ${canonical}`] : []),
      `Selected Spec comments: ${JSON.stringify(comments)}`,
      ...(gate.input.instruction ? [`Revision instruction: ${gate.input.instruction}`] : []),
      "Read only those exact durable Plan, annotation, Grill, and existing Spec inputs. Write a precise implementation Spec as UTF-8 Markdown with at least one H1. Do not use the Plan storage schema, do not create issue-tracker artifacts, and do not mutate Plan, annotations, or Grill.",
      `Write only the transient writer draft ${output}; never write the repository-owned canonical Spec ${canonical}. Then upload the exact draft bytes and do not edit them afterward:`,
      `curl --fail-with-body --silent --show-error --request POST --header 'Authorization: Bearer ${gate.attemptId}' --header 'Content-Type: text/markdown' --header 'X-Pi-Prompt-Result: spec' --data-binary '@${output}' '${gate.writerEndpoint}'`,
      "If the upload returns an error, inspect the response, fix the transient draft, and retry the same upload during this turn. The gate remains active until a submission is accepted or this turn ends.",
      "The authenticated HTTP bytes are the sole result authority.",
    ].join("\n\n");
  }
  #sendSpecFailureFollowUp(input: SpecGeneratorInput, error: { readonly code: string; readonly message: string }): void {
    let draft: string;
    try { draft = writerSpecResultFilePath(input.source.reference.planArtifactPath); } catch { return; }
    const message = [
      "Spec generation handoff", "Stage: Spec", `Plan session ID: ${input.session.planSessionId}`, `Operation: ${input.operation}`,
      `Error code: ${error.code}`, `Error message: ${error.message}`, `Transient draft path: ${draft}`,
      "The submission was not accepted. The current agent may inspect and fix the transient draft, then retry from the browser.",
    ].join("\n");
    try { this.#pi.sendUserMessage(message, { deliverAs: "followUp" }); } catch {}
  }
  #settleSpec(gate: SpecGate, result: SpecGeneratorResult): void { if (["settled", "closed"].includes(gate.state)) return; gate.state = "settled"; gate.active = false; gate.resolve(result); }
  #closeSpecOwner(owner: symbol): void { const gate = this.#activeSpec; if (gate?.owner === owner) this.#closeSpecGate(gate); }
  #closeSpecGate(gate: SpecGate): void { if (["settled", "closed"].includes(gate.state)) return; gate.state = "closed"; gate.active = false; gate.resolve({ ok: false, error: { code: "generation-cancelled", message: "Spec generation was cancelled." } }); }

  async #generate(owner: symbol, input: PlanGeneratorInput, activity?: CurrentAgentActivity, writerEndpoint?: string): Promise<PlanGeneratorResult> {
    const validated = validateGeneratorInput(input);
    if (!validated.ok) return failed("invalid-generator-input", "The plan generation input is invalid.");
    if (this.#active && !["settled", "closed"].includes(this.#active.state) || this.#activeSpec && !["settled", "closed"].includes(this.#activeSpec.state)) return failed("generation-active", "Another plan or Spec generation request is active.");
    const nonce = this.#nonceFactory();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || this.#issuedNonces.has(nonce)) return failed("invalid-nonce", "The plan submission nonce could not be created.");
    this.#issuedNonces.add(nonce);
    const activeAttempt = this.#nextAttempt();
    if (!activeAttempt) return failed("attempt-identity-unavailable", "The private writer attempt identity could not be created.");
    const profile = GENERATION_PROFILES[input.session.generation.mode];
    const adapterKind: PlanningAdapterKind = detectTeamsPlanningCapability(this.#pi, profile.modelSlot) ? "delegated" : "direct";
    let resolve!: (result: PlanGeneratorResult) => void;
    const completion = new Promise<PlanGeneratorResult>((done) => { resolve = done; });
    const gate: Gate = {
      owner, epoch: ++this.#epoch, nonce, input, resolve, activity, adapterKind,
      startedAt: this.#clock().toISOString(), budgetMinutes: profile.timeBudgetMinutes, model: { slot: profile.modelSlot },
      state: "preparing", dispatchRequested: false, correctionAttempts: 0, activeAttempt, ...(writerEndpoint ? { writerEndpoint } : {}),
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
      onPhase: (phase) => this.#teamsPhase(gate, phase),
      onReport: (report) => { this.#primaryReport(gate, report); },
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
      this.#prepareReadyGate(gate);
    } catch {
      if (this.#active === gate) this.#settle(gate, failed("plan-level-unavailable", "The selected planning level could not be loaded."));
    }
  }


  #configureWriterEndpoint(owner: symbol, url: string): PlanDispatchResult {
    if (!validWriterEndpoint(url)) return dispatchFailed("invalid-writer-endpoint", "The private writer endpoint is invalid.");
    const gate = this.#active;
    if (gate?.owner === owner && this.#isOpen(gate)) {
      if (gate.dispatchRequested && gate.writerEndpoint !== url) return dispatchFailed("writer-endpoint-locked", "The active writer endpoint cannot be replaced after dispatch.");
      gate.writerEndpoint = url;
      this.#prepareReadyGate(gate);
    }
    return { ok: true, value: undefined };
  }

  #prepareReadyGate(gate: Gate): void {
    if (!this.#isOpen(gate) || !gate.levelMarkdown || !gate.skills || !gate.writerEndpoint || gate.state !== "preparing") return;
    if (gate.teams && !gate.teams.setMission(this.#childMission(gate))) {
      this.#settle(gate, failed("delegation-mission-unavailable", "The private primary planner mission could not be prepared."));
      return;
    }
    gate.state = "ready";
    if (gate.dispatchRequested) this.#sendRun(gate, "dispatch");
  }

  #dispatch(owner: symbol, jobId: string, isIdle: () => boolean): PlanDispatchResult {
    const gate = this.#active;
    if (!gate || gate.owner !== owner || gate.input.jobId !== jobId || gate.state === "closed" || gate.state === "settled") return dispatchFailed("stale-generation-job", "The generation job is no longer active.");
    if (!gate.writerEndpoint) return dispatchFailed("writer-endpoint-unavailable", "The private writer endpoint is not configured.");
    if (gate.dispatchRequested) return dispatchFailed("duplicate-dispatch", "The generation job was already dispatched.");
    gate.dispatchRequested = true;
    gate.pendingIdle = isIdle;
    if (gate.state === "ready") this.#sendRun(gate, "dispatch");
    return { ok: true, value: undefined };
  }

  #sendRun(gate: Gate, run: RunKind): void {
    if (!this.#isOpen(gate) || gate.sentRun || gate.queuedRun) return;
    const verboseClaim = run === "dispatch" && gate.input.operation === "initial" && !this.#verbosePlanSessions.has(gate.input.session.id);
    if (verboseClaim) this.#verbosePlanSessions.add(gate.input.session.id);
    const marker = this.#visibleRunMarker(gate, run, verboseClaim);
    gate.sentRun = run;
    gate.marker = marker;
    gate.state = "open";
    try {
      if (gate.pendingIdle?.() ?? true) this.#pi.sendUserMessage(marker);
      else this.#pi.sendUserMessage(marker, { deliverAs: "followUp" });
    } catch {
      if (verboseClaim) this.#verbosePlanSessions.delete(gate.input.session.id);
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

  async #submitWriterResult(owner: symbol, input: WriterSubmissionInput): Promise<PlanDispatchResult> {
    const gate = this.#active; const job = gate?.input.session.generationJob;
    if (!gate || gate.owner !== owner || !this.#isOpen(gate) || !gate.skills || !job
      || input.sessionId !== gate.input.session.id || input.jobId !== gate.input.jobId
      || input.operation !== gate.input.operation || input.baseDocumentRevision !== job.baseDocumentRevision
      || input.attemptId !== gate.activeAttempt || !this.#submissionRunActive(gate)) {
      return dispatchFailed("writer-attempt-rejected", "The writer submission is not active.");
    }
    this.#activity(gate, "validating", gate.teams?.primaryStatus ?? "direct");
    if (gate.input.operation === "revision") {
      if (input.kind !== "plan") return dispatchFailed("writer-attempt-rejected", "Revision jobs require a Markdown plan submission.");
      let markdown: string;
      try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.body); }
      catch {
        const invalid = failed("invalid-utf8", "The revision submission must be valid UTF-8.");
        this.#settle(gate, invalid);
        return dispatchFailed(invalid.error.code, invalid.error.message);
      }
      const result = validateRevisionMarkdownPrivacy(markdown, gate.input.session, gate.skills);
      if (!result.ok) {
        this.#settle(gate, result);
        return dispatchFailed(result.error.code, result.error.message);
      }
      this.#activity(gate, "completed", "completed"); this.#settle(gate, result, false);
      return { ok: true, value: undefined };
    }
    let validated: PlanGeneratorResult;
    if (input.kind === "plan") {
      if (gate.input.operation === "grill") return this.#rejectWriterResult(gate, failed("invalid-grill", "Grill jobs require a strict JSON Grill result."));
      let markdown: string;
      try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.body); }
      catch { return this.#rejectWriterResult(gate, failed("invalid-utf8", "The plan submission must be valid UTF-8.")); }
      const parsed = planOutcomeFromMarkdown(markdown, gate.input.operation, gate.input.session, gate.input.selectedAnnotationIds);
      validated = parsed.ok
        ? validateGeneratorSubmission(parsed.value, gate.input.operation, gate.input.session, gate.skills)
        : failed("invalid-plan-file", parsed.issues.map((issue) => `${issue.path} [${issue.code}] ${issue.message}`).join("; "));
      if (validated.ok && validated.outcome.kind !== "clarification" && validated.outcome.kind !== "grill") validated = { ok: true, outcome: { ...validated.outcome, markdown } };
    } else {
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.body); }
      catch {
        if (input.kind === "clarification") this.#settle(gate, failed("invalid-writer-result", "The writer could not submit a valid clarification batch."));
        if (input.kind === "grill") this.#settle(gate, failed("invalid-grill", "The Grill submission must be valid UTF-8."));
        return dispatchFailed(input.kind === "grill" ? "invalid-grill" : "invalid-utf8", `The ${input.kind} submission must be valid UTF-8.`);
      }
      const parsed = parseStrictJsonObject(text, { maxBytes: input.kind === "grill" ? MAX_GRILL_RESULT_BYTES : MAX_WRITER_RESULT_BYTES, maxDepth: 14 });
      validated = parsed.ok
        ? input.kind === "grill" ? validateGrillSubmission(parsed.value, gate.input.session, gate.skills) : validateClarificationSubmission(parsed.value, gate.input.session, gate.skills)
        : failed(input.kind === "grill" ? "invalid-grill" : "invalid-clarification", parsed.issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
    }
    if (!validated.ok) {
      if (input.kind === "clarification") {
        this.#settle(gate, failed("invalid-writer-result", "The writer could not submit a valid clarification batch."));
        return dispatchFailed(validated.error.code, validated.error.message);
      }
      return this.#rejectWriterResult(gate, validated);
    }
    this.#activity(gate, "completed", "completed"); this.#settle(gate, validated, false);
    return { ok: true, value: undefined };
  }

  #rejectWriterResult(gate: Gate, invalid: PlanGeneratorResult & { readonly ok: false }): PlanDispatchResult {
    if (gate.correctionAttempts >= 1 || gate.input.signal.aborted) {
      this.#settle(gate, gate.input.operation === "grill" ? invalid : failed("invalid-writer-result", "The writer could not submit a valid result."));
      return dispatchFailed(invalid.error.code, invalid.error.message);
    }
    const correctionAttempt = this.#nextAttempt();
    if (!correctionAttempt) {
      this.#settle(gate, failed("attempt-identity-unavailable", "The private correction attempt identity could not be created."));
      return dispatchFailed("attempt-identity-unavailable", "The private correction attempt identity could not be created.");
    }
    gate.activeAttempt = correctionAttempt; gate.correctionAttempts = 1; gate.correctionFeedback = invalid.error.message;
    this.#activity(gate, "recovering", gate.teams?.primaryStatus ?? "direct");
    if (gate.adapterKind === "delegated") this.#beginCorrection(gate);
    return dispatchFailed(invalid.error.code, invalid.error.message);
  }

  #submissionRunActive(gate: Gate): boolean {
    if (gate.adapterKind === "direct") return gate.activeRun === "dispatch" || gate.activeRun === "correction";
    return gate.teams?.primaryCount === 1 && ["active", "waiting", "report-received"].includes(gate.teams.primaryStatus);
  }

  #teamsPhase(gate: Gate, phase: TeamsAdapterPhase): void {
    if (!this.#isOpen(gate)) return;
    this.#activity(gate, phase, gate.teams?.primaryStatus ?? "not-started");
  }

  #primaryProgress(gate: Gate, summary: string, updatedAt: number): void {
    if (!this.#isOpen(gate) || gate.privateReport !== undefined || !gate.teams) return;
    this.#activity(gate, "waiting-report", gate.teams.primaryStatus, { summary, updatedAt: new Date(updatedAt).toISOString() });
  }

  #primaryReport(gate: Gate, report: string): void {
    if (!this.#isOpen(gate) || gate.privateReport !== undefined || !gate.skills) return;
    gate.privateReport = report; // Cleanup/advisory signal only; correlated HTTP bytes are sole result authority.
    this.#activity(gate, "report-received", "report-received");
    this.#beginCorrection(gate);
  }

  #beginCorrection(gate: Gate): void {
    if (!this.#isOpen(gate) || gate.activeRun || !gate.correctionFeedback || gate.correctionAttempts !== 1 || gate.teams?.primaryStatus !== "report-received") return;
    if (!gate.teams.prepareRetry(this.#correctionMission(gate))) { this.#settle(gate, failed("correction-unavailable", "The submitted plan could not be corrected safely.")); return; }
    gate.privateReport = undefined; this.#activity(gate, "recovering", "not-started"); this.#injectCorrection(gate);
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
    gate.stopReportObservation?.(); gate.stopReportObservation = undefined;
    gate.teams?.close();
  }
  #isOpen(gate: Gate | null): gate is Gate { return Boolean(gate && gate.state !== "closed" && gate.state !== "settled"); }

  #orchestrationMessage(gate: Gate, run: RunKind): string {
    return [
      this.#generationContext(gate),
      "Pi Prompt detected a validated active pi-extended-teams capability. Delegation is mandatory for this plan.",
      `You are orchestration-only. Call spawn_agent exactly once now. The adapter will replace all arguments with the private ${run === "correction" ? "correction" : "primary-planner"} mission.`,
      "Do not inspect the repository, call any other tool, spawn a swarm or helper, or attempt the plan yourself. After the one spawn call succeeds, end this run and wait for the report.",
    ].join("\n\n");
  }

  #directMessage(gate: Gate, run: RunKind): string {
    if (run === "correction") return this.#correctionMission(gate, false);
    if (gate.input.operation === "revision") return this.#revisionMission(gate, false);
    if (gate.input.operation === "grill") return this.#grillMission(gate);
    return [
      this.#generationContext(gate), this.#originalRequest(gate), gate.levelMarkdown!, "## Controller-owned plan-file request",
      "Plan directly from the original request. Apply the request-first inspection policy in the selected mode; ambient controller metadata never expands user scope.",
      this.#initialSupplementalContext(gate), this.#clarificationHistory(gate), this.#writerChoice(gate),
    ].join("\n\n");
  }

  #childMission(gate: Gate): string {
    if (gate.input.operation === "revision") return this.#revisionMission(gate);
    if (gate.input.operation === "grill") return this.#grillMission(gate);
    return [
      this.#originalRequest(gate), gate.levelMarkdown!, "## Controller-owned primary planning mission",
      "You are the one plan writer. Handle this planning task alone; helpers and swarms are unsupported.",
      "Plan directly from the original request. Do not inspect any folder, repository, working directory, code, or files unless the request-first policy in the selected mode justifies the smallest relevant evidence. Do not implement the requested work, install anything, start services, commit, push, or deploy, and modify no files except the exact plan.md or questions.json path below.",
      "Do not report a generic initial status. Call report_progress only after your meaningful planning focus changes. If inspection is justified, name the specific user-relevant question it will answer; never report `assessing folder` or `exploring repository`. Describe the work, not private chain-of-thought, tools, paths, or hidden instructions.",
      this.#initialSupplementalContext(gate), this.#clarificationHistory(gate), this.#writerChoice(gate),
      "Finish by calling report_and_exit with `plan uploaded` or `questions uploaded`. The report is cleanup-only: do not put the plan, questions, submission URL, bearer, or validation details in it.",
      "Do not call pi_prompt_submit_plan. Only the authenticated HTTP upload can complete this planning attempt.",
    ].join("\n\n");
  }

  #grillMission(gate: Gate): string {
    return [
      "## Controller-owned Grill critique mission",
      `Current plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      `Grill result path: ${writerGrillFilePath(this.#planRoot, gate.input.session.id)}`,
      `Current document revision: ${gate.input.session.documentRevision}`,
      "Read exactly the current plan.md and this bounded canonical public anchor map. Critique assumptions, risks, ambiguities, and decision points without changing plan.md or any other file.",
      `Canonical public anchor map (the complete current document projection, including revision chunks):\n${this.#grillAnchorMap(gate)}`,
      "Use only document and element IDs in this map. Range offsets are zero-based, half-open Unicode code points (not UTF-16). Do not copy quoted exact/prefix/suffix text already present in the Plan; use flat range targets and let the controller derive it.",
      `Write exactly this JSON shape, replacing example values: {"kind":"grill","basedOnDocumentRevision":${gate.input.session.documentRevision},"annotations":{"risk":{"target":{"kind":"range","elementId":"anchor-id","field":"body","start":0,"end":4},"body":"State the concern."}},"decisionTree":{"nodes":[{"id":"root","question":"Proceed?","annotationKeys":["risk"],"options":[{"id":"yes","label":"Yes","decision":"Proceed."},{"id":"no","label":"No","decision":"Revise."}]}]}}`,
      "A canonical selector range target is also accepted. Omit rootNodeId only when nextNodeId edges have exactly one zero-indegree root. Every annotation key appears exactly once; each option has exactly one nextNodeId or decision; nodes are reachable and acyclic. No findings is annotations {} with decisionTree {nodes:[]}.",
      `Upload the exact result bytes and do not edit them afterward:\n${this.#grillUpload(gate)}`,
      "Modify only grill-result.json. Do not call pi_prompt_submit_plan.",
    ].join("\n\n");
  }

  #grillAnchorMap(gate: Gate): string {
    const document = gate.input.session.document;
    if (!document) return JSON.stringify({ documentRevision: gate.input.session.documentRevision, anchors: [] });
    const offsets = "zero-based half-open Unicode code-point [start,end) offsets within exact field text";
    const anchors: Array<Record<string, unknown>> = [{ target: { kind: "root", elementId: document.id }, elementKind: "root" }];
    const append = (element: typeof document.title): void => {
      anchors.push({
        target: { kind: "element", elementId: element.id }, elementKind: element.kind,
        fields: {
          title: element.title === undefined ? null : { exact: element.title, offsets },
          body: { exact: element.body, offsets },
        },
      });
      element.children.forEach(append);
    };
    append(document.title); document.elements.forEach(append);
    return JSON.stringify({ documentRevision: gate.input.session.documentRevision, documentId: document.id, anchors });
  }

  #revisionMission(gate: Gate, delegated = true): string {
    return [
      this.#revisionContext(gate),
      `Write the complete replacement plan as UTF-8 Markdown to ${planFilePath(this.#planRoot, gate.input.session.id)}.`,
      `Upload those exact bytes and do not edit plan.md afterward:\n${this.#planUpload(gate)}`,
      delegated ? "Finish by calling report_and_exit with `plan uploaded`; the report is cleanup-only and must contain no result bytes or credentials." : "After the upload, end this run. Do not call pi_prompt_submit_plan.",
    ].join("\n\n");
  }

  #revisionContext(gate: Gate): string {
    const selected = new Set(gate.input.selectedAnnotationIds);
    const notes = gate.input.session.annotations.filter((annotation) => selected.has(annotation.id));
    const noteText = notes.map((annotation) => `- [${annotation.id}] ${annotation.body}`).join("\n") || "(none)";
    return [
      "## Controller-owned revision mission",
      "You are revising the existing plan in place, not creating a new plan.",
      `Current plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      `Annotations path: ${annotationsFilePath(this.#planRoot, gate.input.session.id)}`,
      `Selected note text:\n${noteText}`,
      ...(gate.input.instruction ? [`Additional revision instruction: ${gate.input.instruction}`] : []),
      "Read the current plan and apply only the supplied selected note text and optional additional instruction. Read annotations.json only if needed to understand a selected note. Preserve every unmentioned section, task, constraint, and decision.",
      "Do not inspect the repository or working directory. Modify only plan.md; do not modify annotations.json or any other file.",
      this.#clarificationHistory(gate),
    ].join("\n\n");
  }

  #correctionMission(gate: Gate, delegated = true): string {
    if (gate.input.operation === "grill") return [this.#grillMission(gate), `Validation feedback: ${gate.correctionFeedback ?? "The submitted Grill result was invalid."}`, "Fix only the validation feedback and re-upload."].join("\n\n");
    return [
      "## Saved plan correction",
      `Plan path: ${planFilePath(this.#planRoot, gate.input.session.id)}`,
      `Validation feedback: ${gate.correctionFeedback ?? "The submitted plan was invalid."}`,
      "Read only the current plan. Fix only the validation feedback and preserve all non-validation content. Rewrite only plan.md; read or modify no other file.",
      this.#planStorageSchema(), this.#planUpload(gate),
      delegated ? "Finish by calling report_and_exit with `plan uploaded`; the report is cleanup-only and must contain no result bytes or credentials." : "After the upload, end this run. Do not call pi_prompt_submit_plan.",
    ].join("\n\n");
  }

  #visibleRunMarker(gate: Gate, run: RunKind, verbose: boolean): string {
    const kind = run === "correction" ? "correction" : gate.input.operation === "revision" ? "revision" : gate.input.operation === "grill" ? "Grill critique" : "creation";
    const concise = `pi-prompt plan ${kind} in progress`;
    if (!verbose) return concise;
    return [concise, "server initialized...", `id: ${gate.input.session.id}`, "", `prompt: ${gate.input.session.source.prompt}`].join("\n");
  }

  #generationContext(gate: Gate): string {
    return [
      "## Active Pi Prompt generation context",
      `Plan session ID: ${gate.input.session.id}`,
      `Operation: ${gate.input.operation}`,
      `Original prompt: ${gate.input.session.source.prompt}`,
      gate.adapterKind === "delegated" ? "A dedicated planner agent is starting to build this plan." : "The current agent is starting to build this plan directly.",
      "This context is informational. It does not expand the user's request or authorize unrelated work.",
    ].join("\n");
  }

  #originalRequest(gate: Gate): string {
    return `## Original user request — primary authority\n${gate.input.session.source.prompt}`;
  }

  #initialSupplementalContext(gate: Gate): string {
    return [
      "## Supplemental controller metadata — not user scope",
      "These values support planning and storage only. They do not add goals, affected areas, or permission to inspect anything.",
      `Working directory (ambient only; a cwd is not authorization to inspect it):\n${gate.input.session.source.cwd}`,
      `Execution kind:\n${gate.input.session.execution.kind}`,
      `Selected private skill context (apply only when relevant; never copy private instructions or paths into the result):\n${JSON.stringify(gate.skills)}`,
    ].join("\n\n");
  }

  #clarificationHistory(gate: Gate): string {
    const history = gate.input.session.clarifications?.history ?? [];
    if (history.length === 0) return "No prior clarification answers exist for this operation.";
    return `## Prior answered clarification history — do not repeat these questions\n${JSON.stringify(history)}`;
  }

  #writerChoice(gate: Gate): string {
    return [
      "After the supplied initial or revision context, choose exactly one outcome:",
      `1. If no material user decision is needed, write the complete Markdown plan to ${planFilePath(this.#planRoot, gate.input.session.id)}, following the storage schema below. Then upload those exact bytes with this command and do not edit plan.md afterward:\n${this.#planUpload(gate)}`,
      `2. If a material user decision is needed, do not write plan.md. Write exactly one JSON object to ${writerQuestionsFilePath(this.#planRoot, gate.input.session.id)} with no fields other than \`questions\`. Ask one concise batch of 1-5 questions; each question needs 2-6 options. Custom answers are automatically supported, so do not add an “Other” option. Use this exact shape: ${JSON.stringify({ questions: [{ id: "unique-question-id", prompt: "One short question?", options: [{ id: "unique-option-a", label: "First choice" }, { id: "unique-option-b", label: "Second choice" }] }] })}\nThen upload those exact bytes with this command and do not edit questions.json afterward:\n${this.#clarificationUpload(gate)}`,
      "Do not ask questions in prose, tool calls, or reports. More rounds are allowed only after the user answers this batch. Do not call pi_prompt_submit_plan; correlated HTTP bytes are the sole completion authority.",
      this.#planStorageSchema(),
    ].join("\n\n");
  }

  #planUpload(gate: Gate): string {
    return this.#uploadCommand(gate, "plan", planFilePath(this.#planRoot, gate.input.session.id), "text/markdown");
  }

  #clarificationUpload(gate: Gate): string {
    return this.#uploadCommand(gate, "clarification", writerQuestionsFilePath(this.#planRoot, gate.input.session.id), "application/json");
  }

  #grillUpload(gate: Gate): string {
    return this.#uploadCommand(gate, "grill", writerGrillFilePath(this.#planRoot, gate.input.session.id), "application/json");
  }

  #uploadCommand(gate: Gate, result: "plan" | "clarification" | "grill", path: string, contentType: string): string {
    return `curl --fail-with-body --silent --show-error --request POST --header 'Authorization: Bearer ${gate.activeAttempt}' --header 'Content-Type: ${contentType}' --header 'X-Pi-Prompt-Result: ${result}' --data-binary '@${path}' '${gate.writerEndpoint}'`;
  }

  #nextAttempt(): string | null {
    let value: string;
    try { value = this.#attemptFactory(); } catch { return null; }
    if (!/^[A-Za-z0-9_-]{16,64}$/u.test(value) || this.#issuedAttempts.has(value)) return null;
    this.#issuedAttempts.add(value); return value;
  }

  #planStorageSchema(): string {
    return [
      "The following fields are a mandatory storage schema, not evidence that the request is code work:",
      "The file must have one `#` title, exactly one `## Execution` section, and `## Implementation Tasks` with one or more `###` tasks. Every task body must include lines starting `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:`.",
      "For non-code requests, use those fields for the requested actions and verification. Write `Test first: N/A — <reason>` instead of inventing code or tests.",
    ].join("\n");
  }
}

function randomToken(): string { return randomBytes(18).toString("base64url"); }
function validWriterEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && /^(?:[1-9]\d{0,4})$/u.test(url.port)
      && Number(url.port) <= 65_535 && url.pathname === "/api/v1/writer-results" && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function failed(code: string, message: string): PlanGeneratorResult & { readonly ok: false } { return { ok: false, error: { code, message } }; }
function dispatchFailed(code: string, message: string): PlanDispatchResult { return { ok: false, error: { code, message } }; }
function toolFailure(code: string, message: string) {
  return { content: [{ type: "text" as const, text: `${code}: ${message}` }], details: { code, accepted: false }, isError: true };
}
