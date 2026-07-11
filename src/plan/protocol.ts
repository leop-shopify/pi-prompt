import { PLAN_LIMITS, normalizePlanText } from "./schema.js";
import type { Annotation, AnnotationStatus, AnnotationTarget, PlanDocument, PlanElement, PlanSession } from "./types.js";

export const PROTOCOL_VERSION = 1 as const;
export const MUTATION_BODY_MAX_BYTES = 256 * 1024;
export const MAX_REQUEST_ID_LENGTH = 128;
export const MAX_LONG_POLL_MS = 20_000;

export interface PublicPlanElement { readonly id: string; readonly kind: PlanElement["kind"]; readonly title?: string; readonly body: string; readonly children: readonly PublicPlanElement[] }
export interface PublicPlanDocument { readonly id: string; readonly title: PublicPlanElement; readonly elements: readonly PublicPlanElement[] }
export interface PublicAnnotationTargetSummary {
  readonly label: string;
  readonly field?: "title" | "body";
  readonly quote?: string;
  readonly historical?: { readonly elementKind: PlanElement["kind"] | "root"; readonly excerpt: string };
}
export interface PublicAnnotation {
  readonly id: string; readonly target: AnnotationTarget; readonly targetSummary: PublicAnnotationTargetSummary;
  readonly body: string; readonly status: AnnotationStatus; readonly locked: boolean;
  readonly createdAgainstRevision: number; readonly createdAt: string; readonly updatedAt: string;
}
export interface PublicSnapshotActions { readonly canRetryStaging: boolean }
export type PublicActivityPhase =
  | "capability-detected" | "primary-starting" | "primary-active" | "waiting-report" | "report-received"
  | "synthesizing" | "validating" | "recovering" | "completed" | "direct-fallback" | "paused";
export type PublicPrimaryStatus = "not-started" | "starting" | "active" | "waiting" | "report-received" | "closed" | "direct" | "completed" | "paused";
export interface PublicActivity {
  readonly phase: PublicActivityPhase; readonly headline: string; readonly summary: string;
  readonly progress?: { readonly summary: string; readonly updatedAt: string };
  readonly startedAt: string; readonly updatedAt: string; readonly budgetMinutes: number; readonly overBudget: boolean;
  readonly adapter: "delegated" | "direct";
  readonly model: { readonly slot: "writing-basic" | "writing-hard"; readonly model?: string; readonly thinking?: string };
  readonly primary: { readonly count: 0 | 1; readonly status: PublicPrimaryStatus };
  readonly helpers: { readonly supported: false; readonly active: 0 };
  readonly timeline: readonly { readonly phase: PublicActivityPhase; readonly at: string }[];
}
export interface PublicSnapshot {
  readonly protocolVersion: 1; readonly stateVersion: number; readonly documentRevision: number; readonly status: PlanSession["status"];
  readonly execution: PlanSession["execution"]; readonly generation: PlanSession["generation"]; readonly originalPrompt: string; readonly promptPreview: string; readonly document: PublicPlanDocument | null;
  readonly annotations: readonly PublicAnnotation[];
  readonly actions: PublicSnapshotActions;
  readonly activity?: PublicActivity;
  readonly job?: { readonly operation: "initial" | "revision"; readonly baseDocumentRevision: number; readonly startedAt: string };
  readonly error?: { readonly code: string; readonly message: string };
}
export interface PublicEvent { readonly sequence: number; readonly kind: string; readonly status: PlanSession["status"]; readonly stateVersion: number; readonly documentRevision: number; readonly errorCode?: string }

export type AnnotationCreateRequest = { readonly requestId: string; readonly target: AnnotationTarget; readonly body: string };
export type AnnotationPatchRequest = { readonly requestId: string; readonly update: { readonly body: string } | { readonly status: "open" | "dismissed" } };
export type RevisionRequest = { readonly requestId: string; readonly selectedAnnotationIds: readonly string[]; readonly instruction?: string };
export type AcceptRequest = { readonly requestId: string; readonly stateVersion: number; readonly documentRevision: number; readonly confirmed: true };
export type CancelRequest = { readonly requestId: string; readonly disposition: "pause" | "cancel" };
export type ReopenRequest = { readonly requestId: string };
export type MutationRequest = AnnotationCreateRequest | AnnotationPatchRequest | RevisionRequest | AcceptRequest | CancelRequest | ReopenRequest;

/** Explicit public allowlist. Never replace this with a spread or controller.snapshot() serialization. */
export function toPublicSnapshot(session: PlanSession, actions: Partial<PublicSnapshotActions> = {}, activity?: PublicActivity): PublicSnapshot {
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    stateVersion: session.stateVersion,
    documentRevision: session.documentRevision,
    status: session.status,
    execution: Object.freeze({ kind: session.execution.kind }),
    generation: Object.freeze({ mode: session.generation.mode }),
    originalPrompt: session.source.prompt,
    promptPreview: boundedSummary(session.source.prompt),
    document: session.document ? publicDocument(session.document) : null,
    annotations: Object.freeze(session.annotations.map((annotation) => publicAnnotation(annotation, session))),
    actions: Object.freeze({ canRetryStaging: actions.canRetryStaging === true }),
    ...(activity ? { activity: publicActivity(activity) } : {}),
    ...(session.generationJob ? { job: Object.freeze({ operation: session.generationJob.operation, baseDocumentRevision: session.generationJob.baseDocumentRevision, startedAt: session.generationJob.startedAt }) } : {}),
    ...(session.lastError ? { error: Object.freeze({ code: session.lastError.code, message: session.lastError.message }) } : {}),
  });
}

export function stateEtag(stateVersion: number): string { return `\"pi-plan-state-${stateVersion}\"`; }
export function parseStateIfMatch(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^"pi-plan-state-(0|[1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export type RequestKind = "annotation-create" | "annotation-patch" | "revision" | "accept" | "cancel" | "reopen";
export type ParseProtocolResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

export function parseMutation(kind: "annotation-create", value: unknown): ParseProtocolResult<AnnotationCreateRequest>;
export function parseMutation(kind: "annotation-patch", value: unknown): ParseProtocolResult<AnnotationPatchRequest>;
export function parseMutation(kind: "revision", value: unknown): ParseProtocolResult<RevisionRequest>;
export function parseMutation(kind: "accept", value: unknown): ParseProtocolResult<AcceptRequest>;
export function parseMutation(kind: "cancel", value: unknown): ParseProtocolResult<CancelRequest>;
export function parseMutation(kind: "reopen", value: unknown): ParseProtocolResult<ReopenRequest>;
export function parseMutation(kind: RequestKind, value: unknown): ParseProtocolResult<MutationRequest> {
  if (!record(value)) return invalid("invalid-request", "The request body is invalid.");
  if (!requestId(value.requestId)) return invalid("invalid-request-id", "The request ID is invalid.");
  if (kind === "annotation-create") {
    if (!keys(value, ["requestId", "target", "body"]) || typeof value.body !== "string" || !annotationTarget(value.target)) return invalid("invalid-request", "The annotation request is invalid.");
    const body = normalizePlanText(value.body);
    if (!boundedText(body, PLAN_LIMITS.annotationBodyCodePoints, true)) return invalid("invalid-annotation", "The annotation body is invalid.");
    return valid({ requestId: value.requestId, target: value.target, body });
  }
  if (kind === "annotation-patch") {
    if (!keys(value, ["requestId", "update"]) || !record(value.update)) return invalid("invalid-request", "The annotation update is invalid.");
    const update = value.update;
    if (keys(update, ["body"]) && typeof update.body === "string") {
      const body = normalizePlanText(update.body);
      return boundedText(body, PLAN_LIMITS.annotationBodyCodePoints, true) ? valid({ requestId: value.requestId, update: { body } }) : invalid("invalid-annotation", "The annotation body is invalid.");
    }
    if (keys(update, ["status"]) && (update.status === "open" || update.status === "dismissed")) return valid({ requestId: value.requestId, update: { status: update.status } });
    return invalid("invalid-status", "Only open and dismissed status changes are allowed.");
  }
  if (kind === "revision") {
    if (!keys(value, ["requestId", "selectedAnnotationIds"], ["instruction"]) || !idArray(value.selectedAnnotationIds, PLAN_LIMITS.annotations)) return invalid("invalid-request", "The revision request is invalid.");
    if (value.instruction !== undefined && typeof value.instruction !== "string") return invalid("invalid-instruction", "The revision instruction is invalid.");
    const instruction = typeof value.instruction === "string" ? normalizePlanText(value.instruction) : undefined;
    if (instruction !== undefined && Buffer.byteLength(instruction, "utf8") > PLAN_LIMITS.generationInstructionBytes) return invalid("invalid-instruction", "The revision instruction is too long.");
    return valid({ requestId: value.requestId, selectedAnnotationIds: value.selectedAnnotationIds, ...(instruction === undefined ? {} : { instruction }) });
  }
  if (kind === "accept") {
    if (!keys(value, ["requestId", "stateVersion", "documentRevision", "confirmed"]) || !safeVersion(value.stateVersion) || !safeVersion(value.documentRevision) || value.confirmed !== true) return invalid("confirmation-required", "Exact versions and confirmation are required.");
    return valid({ requestId: value.requestId, stateVersion: value.stateVersion, documentRevision: value.documentRevision, confirmed: true });
  }
  if (kind === "cancel") {
    if (!keys(value, ["requestId", "disposition"]) || (value.disposition !== "pause" && value.disposition !== "cancel")) return invalid("invalid-disposition", "Pause or cancel must be selected explicitly.");
    return valid({ requestId: value.requestId, disposition: value.disposition });
  }
  if (!keys(value, ["requestId"])) return invalid("invalid-request", "The reopen request is invalid.");
  return valid({ requestId: value.requestId });
}

export function mutationFingerprint(kind: RequestKind, ifMatch: number, body: MutationRequest): string {
  return `${kind}\n${ifMatch}\n${stableJson(body)}`;
}

function publicActivity(activity: PublicActivity): PublicActivity {
  return Object.freeze({
    phase: activity.phase,
    headline: boundedSummary(activity.headline),
    summary: boundedSummary(activity.summary),
    ...(activity.progress ? { progress: Object.freeze({ summary: boundedProgress(activity.progress.summary), updatedAt: activity.progress.updatedAt }) } : {}),
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
    budgetMinutes: activity.budgetMinutes,
    overBudget: activity.overBudget === true,
    adapter: activity.adapter,
    model: Object.freeze({ slot: activity.model.slot, ...(activity.model.model ? { model: boundedSummary(activity.model.model) } : {}), ...(activity.model.thinking ? { thinking: boundedSummary(activity.model.thinking) } : {}) }),
    primary: Object.freeze({ count: activity.primary.count, status: activity.primary.status }),
    helpers: Object.freeze({ supported: false, active: 0 }),
    timeline: Object.freeze(activity.timeline.slice(-12).map((entry) => Object.freeze({ phase: entry.phase, at: entry.at }))),
  });
}
function publicDocument(document: PlanDocument): PublicPlanDocument {
  return Object.freeze({ id: document.id, title: publicElement(document.title), elements: Object.freeze(document.elements.map(publicElement)) });
}
function publicElement(element: PlanElement): PublicPlanElement {
  return Object.freeze({ id: element.id, kind: element.kind, ...(element.title === undefined ? {} : { title: element.title }), body: element.body, children: Object.freeze(element.children.map(publicElement)) });
}
function publicAnnotation(annotation: Annotation, session: PlanSession): PublicAnnotation {
  const locked = session.generationJob?.selectedAnnotationIds.includes(annotation.id) === true;
  return Object.freeze({
    id: annotation.id, target: cloneTarget(annotation.target), targetSummary: annotationTargetSummary(annotation, session),
    body: annotation.body, status: annotation.status, locked,
    createdAgainstRevision: annotation.createdAgainstRevision, createdAt: annotation.createdAt, updatedAt: annotation.updatedAt,
  });
}
function annotationTargetSummary(annotation: Annotation, session: PlanSession): PublicAnnotationTargetSummary {
  const current = annotation.target.kind === "root" && annotation.target.elementId === session.document?.id
    ? session.document?.title : findElement(session.document, annotation.target.elementId);
  const label = annotation.target.kind === "root"
    ? boundedSummary(session.document?.title.body ?? "Whole plan")
    : boundedSummary(current?.title ?? elementKindLabel(current?.kind ?? annotation.targetSnapshot.elementKind));
  const historical = (annotation.status === "orphaned" || current === undefined)
    ? Object.freeze({ elementKind: annotation.targetSnapshot.elementKind, excerpt: boundedSummary(annotation.targetSnapshot.text) })
    : undefined;
  return Object.freeze({
    label,
    ...(annotation.target.kind === "range" ? { field: annotation.target.selector.field, quote: annotation.target.selector.exact } : {}),
    ...(historical ? { historical } : {}),
  });
}
function findElement(document: PlanDocument | null, id: string): PlanElement | undefined {
  if (!document) return undefined;
  const visit = (element: PlanElement): PlanElement | undefined => element.id === id ? element : element.children.map(visit).find(Boolean);
  return visit(document.title) ?? document.elements.map(visit).find(Boolean);
}
function boundedSummary(value: string): string { return [...value].slice(0, 160).join(""); }
function boundedProgress(value: string): string { return [...value.replace(/\s+/gu, " ").trim()].slice(0, 120).join(""); }
function elementKindLabel(kind: PlanElement["kind"] | "root"): string { return kind === "root" ? "Whole plan" : kind.split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" "); }
function cloneTarget(target: AnnotationTarget): AnnotationTarget {
  return target.kind === "range" ? Object.freeze({ kind: "range", elementId: target.elementId, selector: Object.freeze({ ...target.selector }) }) : Object.freeze({ kind: target.kind, elementId: target.elementId });
}
function annotationTarget(value: unknown): value is AnnotationTarget {
  if (!record(value) || !id(value.elementId)) return false;
  if (value.kind === "root" || value.kind === "element") return keys(value, ["kind", "elementId"]);
  if (value.kind !== "range" || !keys(value, ["kind", "elementId", "selector"]) || !record(value.selector)) return false;
  const selector = value.selector;
  return keys(selector, ["field", "start", "end", "exact"], ["prefix", "suffix"])
    && (selector.field === "title" || selector.field === "body") && safeVersion(selector.start) && safeVersion(selector.end)
    && selector.end > selector.start && typeof selector.exact === "string" && boundedText(selector.exact, PLAN_LIMITS.selectorExactCodePoints, true)
    && (selector.prefix === undefined || typeof selector.prefix === "string" && boundedText(selector.prefix, PLAN_LIMITS.selectorContextCodePoints, false))
    && (selector.suffix === undefined || typeof selector.suffix === "string" && boundedText(selector.suffix, PLAN_LIMITS.selectorContextCodePoints, false));
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const actual = Object.keys(value); return required.every((key) => actual.includes(key)) && actual.every((key) => required.includes(key) || optional.includes(key)); }
function id(value: unknown): value is string { return typeof value === "string" && /^[!-~]{1,64}$/.test(value); }
function requestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._~-]{16,128}$/.test(value); }
function idArray(value: unknown, max: number): value is string[] { return Array.isArray(value) && value.length <= max && value.every(id) && new Set(value).size === value.length; }
function safeVersion(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function boundedText(value: string, max: number, nonblank: boolean): boolean { return !value.includes("\0") && [...value].length <= max && (!nonblank || value.trim().length > 0); }
function valid<T>(value: T): ParseProtocolResult<T> { return { ok: true, value }; }
function invalid<T = never>(code: string, message: string): ParseProtocolResult<T> { return { ok: false, code, message }; }
