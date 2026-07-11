import type {
  ExtensionAPI, ToolCallEvent, ToolInfo, ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { PlanningModelSlot } from "../plan/modes.js";

export const TEAMS_REPORT_CHANNEL = "pi-extended-teams:agent-report";
export const TEAMS_PROGRESS_CHANNEL = "pi-extended-teams:agent-progress";
export const TEAMS_SPAWN_TOOL = "spawn_agent";
export const TEAMS_SWARM_TOOL = "spawn_swarm_agents";
export const TEAMS_MESSAGE_TOOL = "send_message";

export type DelegatedPrimaryStatus = "not-started" | "starting" | "active" | "waiting" | "report-received" | "closed";
export type TeamsAdapterPhase = "primary-starting" | "primary-active" | "waiting-report" | "report-received";

export interface TeamsCapabilityCatalog {
  getActiveTools(): string[];
  getAllTools(): ToolInfo[];
}

export interface PlanningModelInfo {
  readonly slot: PlanningModelSlot;
  readonly model?: string;
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface TeamsPlanningAdapterOptions {
  readonly primaryName: string;
  readonly correlation: string;
  readonly cwd: string;
  readonly mission: string;
  readonly modelSlot: PlanningModelSlot;
  readonly submitToolName: string;
  readonly onPhase: (phase: TeamsAdapterPhase) => void;
  readonly onReport: (report: string) => void;
  readonly onProgress: (status: string, updatedAt: number) => void;
  readonly onModel?: (model: PlanningModelInfo) => void;
  readonly now?: () => number;
}

/** Detects the supported teams tool by active state, schema, and Pi-owned provenance metadata. */
export function detectTeamsPlanningCapability(catalog: TeamsCapabilityCatalog, requiredSlot: PlanningModelSlot = "writing-hard"): boolean {
  try {
    if (!catalog.getActiveTools().includes(TEAMS_SPAWN_TOOL)) return false;
    const candidates = catalog.getAllTools().filter((candidate) => candidate.name === TEAMS_SPAWN_TOOL);
    return candidates.length === 1 && validSpawnTool(candidates[0]!, requiredSlot);
  } catch {
    return false;
  }
}

/** Single-writer policy for the current lead run. Child tool calls are not top-level Pi events. */
export class TeamsPlanningAdapter {
  readonly #options: TeamsPlanningAdapterOptions;
  #mission: string;
  #spawnAttempts = 0;
  #primaryStatus: DelegatedPrimaryStatus = "not-started";
  #spawnToolCallId: string | null = null;
  #reportAccepted = false;
  #followUpAccepted = false;
  #acceptedReport: string | null = null;
  #expectedTeamName: string | null = null;
  #progressFloor = 0;
  #latestProgressAt = 0;
  #closed = false;

  constructor(options: TeamsPlanningAdapterOptions) { this.#options = options; this.#mission = options.mission; }

  get primaryCount(): number { return this.#spawnAttempts > 0 ? 1 : 0; }
  setMission(mission: string): boolean {
    if (this.#closed || this.#spawnAttempts !== 0) return false;
    this.#mission = mission;
    return true;
  }
  prepareRetry(mission: string): boolean {
    if (this.#closed || this.#primaryStatus !== "report-received" || mission.trim().length === 0) return false;
    this.#mission = mission;
    this.#primaryStatus = "not-started";
    this.#spawnToolCallId = null;
    this.#reportAccepted = false;
    this.#followUpAccepted = false;
    this.#acceptedReport = null;
    this.#expectedTeamName = null;
    this.#progressFloor = 0;
    this.#latestProgressAt = 0;
    return true;
  }
  get primaryStatus(): DelegatedPrimaryStatus { return this.#primaryStatus; }

  handleToolCall(event: ToolCallEvent): void {
    if (this.#closed || event.toolName !== TEAMS_SPAWN_TOOL || this.#primaryStatus !== "not-started") return;

    this.#spawnAttempts += 1;
    this.#primaryStatus = "starting";
    this.#progressFloor = Math.trunc(this.#options.now?.() ?? Date.now());
    this.#spawnToolCallId = event.toolCallId;
    replaceInput(event.input, {
      prompt: this.#mission,
      model_slot: this.#options.modelSlot,
      name: this.#options.primaryName,
      cwd: this.#options.cwd,
      metadata: { piPromptPlanning: { version: 1, correlation: this.#options.correlation } },
    });
    this.#options.onPhase("primary-starting");
  }

  handleToolResult(event: ToolResultEvent): void {
    if (this.#closed || event.toolName !== TEAMS_SPAWN_TOOL || event.toolCallId !== this.#spawnToolCallId || this.#primaryStatus !== "starting") return;
    const details = asRecord(event.details);
    if (event.isError || details?.name !== this.#options.primaryName) return;
    this.#expectedTeamName = nonblankString(details.session);
    const model = safeModelInfo(details, this.#options.modelSlot);
    if (model) this.#options.onModel?.(model);
    this.#primaryStatus = "active";
    this.#options.onPhase("primary-active");
    this.#primaryStatus = "waiting";
    this.#options.onPhase("waiting-report");
  }

  handleProgress(payload: unknown): boolean {
    if (this.#closed || this.#reportAccepted || this.#primaryStatus !== "waiting") return false;
    const progress = asRecord(payload);
    if (progress?.name !== this.#options.primaryName || typeof progress.teamName !== "string"
      || (this.#expectedTeamName !== null && progress.teamName !== this.#expectedTeamName)
      || typeof progress.updatedAt !== "number" || !Number.isSafeInteger(progress.updatedAt)
      || progress.updatedAt < this.#progressFloor || progress.updatedAt <= this.#latestProgressAt) return false;
    const status = normalizeProgressStatus(progress.status);
    if (!status) return false;
    this.#latestProgressAt = progress.updatedAt;
    this.#options.onProgress(status, progress.updatedAt);
    return true;
  }

  handleReport(payload: unknown): boolean {
    if (this.#closed || this.#reportAccepted || this.#primaryStatus !== "waiting") return false;
    const report = asRecord(payload);
    if (report?.name !== this.#options.primaryName || typeof report.ok !== "boolean" || typeof report.report !== "string" || report.report.trim().length === 0) return false;
    this.#reportAccepted = true;
    this.#acceptedReport = report.report;
    this.#primaryStatus = "report-received";
    this.#options.onPhase("report-received");
    this.#options.onReport(report.report);
    return true;
  }

  handleFollowUp(message: unknown): boolean {
    if (this.#closed || !this.#reportAccepted || this.#followUpAccepted || this.#acceptedReport === null) return false;
    const candidate = asRecord(message);
    const details = asRecord(candidate?.details);
    if (candidate?.role !== "custom" || candidate.customType !== "pi-extended-teams-report"
      || candidate.content !== this.#acceptedReport || details?.name !== this.#options.primaryName) return false;
    this.#followUpAccepted = true;
    return true;
  }

  close(): void { this.#closed = true; this.#primaryStatus = "closed"; }
}

export function observeTeamsEvents(
  events: Pick<ExtensionAPI["events"], "on">,
  adapter: TeamsPlanningAdapter,
): () => void {
  const stopReports = events.on(TEAMS_REPORT_CHANNEL, (payload) => { adapter.handleReport(payload); });
  const stopProgress = events.on(TEAMS_PROGRESS_CHANNEL, (payload) => { adapter.handleProgress(payload); });
  return () => { stopProgress(); stopReports(); };
}

function validSpawnTool(tool: ToolInfo, requiredSlot: PlanningModelSlot): boolean {
  if (!validTeamsProvenance(tool.sourceInfo)) return false;
  const schema = asRecord(tool.parameters);
  const properties = asRecord(schema?.properties);
  const required = schema?.required;
  if (schema?.type !== "object" || !Array.isArray(required) || !required.includes("prompt") || !required.includes("model_slot") || !properties) return false;
  const prompt = asRecord(properties.prompt);
  const modelSlot = asRecord(properties.model_slot);
  const name = asRecord(properties.name);
  const cwd = asRecord(properties.cwd);
  const metadata = asRecord(properties.metadata);
  return prompt?.type === "string" && name?.type === "string" && cwd?.type === "string" && metadata?.type === "object"
    && modelSlot?.type === "string" && Array.isArray(modelSlot.enum) && modelSlot.enum.includes(requiredSlot);
}

function validTeamsProvenance(sourceInfo: ToolInfo["sourceInfo"]): boolean {
  if (sourceInfo.origin !== "package" || sourceInfo.source === "builtin" || sourceInfo.source === "sdk") return false;
  return hasPackageIdentity(sourceInfo.source) || hasPackageIdentity(sourceInfo.path);
}

function hasPackageIdentity(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLowerCase();
  return normalized.split("/").some((segment) => segment === "pi-extended-teams" || segment.startsWith("pi-extended-teams@"))
    || /(?:^|:)pi-extended-teams(?:@[^/]+)?$/u.test(normalized);
}

function normalizeProgressStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const status = value.replace(/\s+/gu, " ").trim();
  return status ? [...status].slice(0, 120).join("") : null;
}
function nonblankString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function safeModelInfo(details: Record<string, unknown>, expectedSlot: PlanningModelSlot): PlanningModelInfo | null {
  if (details.modelSlot !== expectedSlot) return null;
  const model = typeof details.model === "string" && /^[A-Za-z0-9._:/-]{1,160}$/u.test(details.model) ? details.model : undefined;
  const thinking = typeof details.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh"].includes(details.thinking)
    ? details.thinking as PlanningModelInfo["thinking"] : undefined;
  return { slot: expectedSlot, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}
function replaceInput(target: Record<string, unknown>, canonical: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, canonical);
}
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
