import { SPEC_LIMITS } from "./schema.js";
import type { SpecComment, SpecSession } from "./types.js";

export const SPEC_PROTOCOL_VERSION = 1 as const;
export type SpecRequestKind = "generate" | "fresh-generation" | "comment-create" | "comment-edit" | "comment-status" | "revision" | "accept" | "cancel";
export type SpecMutation =
  | { readonly requestId: string }
  | { readonly requestId: string; readonly start: number; readonly end: number; readonly body: string }
  | { readonly requestId: string; readonly body: string }
  | { readonly requestId: string; readonly status: "open" | "dismissed" }
  | { readonly requestId: string; readonly selectedCommentIds: readonly string[]; readonly instruction?: string }
  | { readonly requestId: string; readonly stateVersion: number; readonly specRevision: number; readonly confirmed: true }
  | { readonly requestId: string; readonly disposition: "pause" | "cancel" };
export interface PublicSpecComment { readonly id: string; readonly target: SpecComment["target"]; readonly body: string; readonly status: SpecComment["status"]; readonly locked: boolean; readonly createdAt: string; readonly updatedAt: string }
export interface PublicSpecSnapshot { readonly protocolVersion: 1; readonly planSessionId: string; readonly stateVersion: number; readonly specRevision: number; readonly status: SpecSession["status"]; readonly markdown: string | null; readonly comments: readonly PublicSpecComment[]; readonly source: { readonly planDocumentRevision: number; readonly planStateVersion: number; readonly grillBasedOnDocumentRevision: number; readonly grillStateVersion: number }; readonly job?: { readonly id: string; readonly operation: "initial" | "revision"; readonly baseSpecRevision: number; readonly startedAt: string }; readonly error?: { readonly code: string; readonly message: string }; readonly actions: { readonly canRetryStaging: boolean } }
export type ParseSpecResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

export function toPublicSpecSnapshot(session: SpecSession, canRetryStaging = false): PublicSpecSnapshot {
  return Object.freeze({ protocolVersion: 1, planSessionId: session.planSessionId, stateVersion: session.stateVersion, specRevision: session.specRevision, status: session.status, markdown: session.markdown,
    comments: Object.freeze(session.comments.map((comment) => Object.freeze({ id: comment.id, target: Object.freeze({ ...comment.target }), body: comment.body, status: comment.status, locked: session.generationJob?.selectedCommentIds.includes(comment.id) === true, createdAt: comment.createdAt, updatedAt: comment.updatedAt }))),
    source: Object.freeze({ planDocumentRevision: session.source.planDocumentRevision, planStateVersion: session.source.planStateVersion, grillBasedOnDocumentRevision: session.source.grillBasedOnDocumentRevision, grillStateVersion: session.source.grillStateVersion }),
    ...(session.generationJob ? { job: Object.freeze({ id: session.generationJob.jobId, operation: session.generationJob.operation, baseSpecRevision: session.generationJob.baseSpecRevision, startedAt: session.generationJob.startedAt }) } : {}),
    ...(session.lastError ? { error: Object.freeze({ code: session.lastError.code, message: session.lastError.message }) } : {}), actions: Object.freeze({ canRetryStaging }),
  });
}
export function specStateEtag(version: number): string { return `"pi-spec-state-${version}"`; }
export function parseSpecIfMatch(value: string | undefined): number | null { const match = /^"pi-spec-state-(0|[1-9]\d*)"$/u.exec(value ?? ""); if (!match) return null; const result = Number(match[1]); return Number.isSafeInteger(result) ? result : null; }
export function parseSpecMutation(kind: SpecRequestKind, value: unknown): ParseSpecResult<SpecMutation> {
  if (!record(value) || !requestId(value.requestId)) return invalid("invalid-request", "Spec mutation request is invalid.");
  if (kind === "generate" || kind === "fresh-generation") return exact(value, ["requestId"]) ? valid({ requestId: value.requestId }) : invalid("invalid-request", "Spec generation request is invalid.");
  if (kind === "comment-create") { if (!exact(value, ["requestId", "start", "end", "body"]) || !safe(value.start) || !safe(value.end) || value.end <= value.start || typeof value.body !== "string" || !text(value.body, SPEC_LIMITS.commentBodyCodePoints)) return invalid("invalid-comment", "Spec comment is invalid."); return valid({ requestId: value.requestId, start: value.start, end: value.end, body: value.body.trim() }); }
  if (kind === "comment-edit") { if (!exact(value, ["requestId", "body"]) || typeof value.body !== "string" || !text(value.body, SPEC_LIMITS.commentBodyCodePoints)) return invalid("invalid-comment", "Spec comment body is invalid."); return valid({ requestId: value.requestId, body: value.body.trim() }); }
  if (kind === "comment-status") { if (!exact(value, ["requestId", "status"]) || (value.status !== "open" && value.status !== "dismissed")) return invalid("invalid-status", "Only open and dismissed are allowed."); return valid({ requestId: value.requestId, status: value.status }); }
  if (kind === "revision") { if (!exact(value, ["requestId", "selectedCommentIds"], ["instruction"]) || !Array.isArray(value.selectedCommentIds) || value.selectedCommentIds.length > SPEC_LIMITS.comments || !value.selectedCommentIds.every(id) || new Set(value.selectedCommentIds).size !== value.selectedCommentIds.length || value.instruction !== undefined && typeof value.instruction !== "string") return invalid("invalid-revision", "Spec revision request is invalid."); const instruction = typeof value.instruction === "string" ? value.instruction.trim() : undefined; if (instruction !== undefined && Buffer.byteLength(instruction, "utf8") > SPEC_LIMITS.instructionBytes) return invalid("invalid-instruction", "Spec revision instruction is too long."); return valid({ requestId: value.requestId, selectedCommentIds: value.selectedCommentIds, ...(instruction ? { instruction } : {}) }); }
  if (kind === "accept") { if (!exact(value, ["requestId", "stateVersion", "specRevision", "confirmed"]) || !safe(value.stateVersion) || !safe(value.specRevision) || value.confirmed !== true) return invalid("confirmation-required", "Exact Spec versions and confirmation are required."); return valid({ requestId: value.requestId, stateVersion: value.stateVersion, specRevision: value.specRevision, confirmed: true }); }
  if (!exact(value, ["requestId", "disposition"]) || (value.disposition !== "pause" && value.disposition !== "cancel")) return invalid("invalid-disposition", "Pause or cancel must be explicit."); return valid({ requestId: value.requestId, disposition: value.disposition });
}
export function specMutationFingerprint(kind: SpecRequestKind, expected: number, body: SpecMutation): string { return `${kind}\n${expected}\n${stable(body)}`; }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean { const keys = Object.keys(value); return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function requestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9._~-]{16,128}$/u.test(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[!-~]{1,64}$/u.test(value); }
function safe(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function text(value: string, max: number): boolean { return !value.includes("\0") && value.trim().length > 0 && [...value].length <= max; }
function valid<T>(value: T): ParseSpecResult<T> { return { ok: true, value }; }
function invalid<T = never>(code: string, message: string): ParseSpecResult<T> { return { ok: false, code, message }; }
