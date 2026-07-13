import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SpecComment, SpecRangeTarget, SpecSession, SpecSourceReference } from "./types.js";

export const SPEC_LIMITS = Object.freeze({
  markdownBytes: 512 * 1024, comments: 512, commentBodyCodePoints: 16_384,
  exactCodePoints: 16_384, contextCodePoints: 256, instructionBytes: 32 * 1024,
});
const STATUSES = new Set(["paused", "generating", "ready", "revising", "accepted", "cancelled", "error"]);
const COMMENT_STATUSES = new Set(["open", "addressed", "dismissed", "orphaned"]);

export type SpecSchemaResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly { readonly path: string; readonly code: string; readonly message: string }[] };

export function validateSpecMarkdown(value: unknown): SpecSchemaResult<string> {
  if (typeof value !== "string") return invalid("invalid-spec", "Spec must be UTF-8 Markdown text.");
  if (value.includes("\0") || value.trim().length === 0 || Buffer.byteLength(value, "utf8") > SPEC_LIMITS.markdownBytes) return invalid("invalid-spec", "Spec Markdown is blank or too large.");
  const h1Candidate = value.startsWith("\uFEFF") ? value.slice(1) : value;
  if (!/^#\s+\S.*$/mu.test(h1Candidate)) return invalid("missing-h1", "Spec Markdown must contain an H1 heading.");
  return { ok: true, value };
}

export function validateSpecSourceReference(value: unknown): SpecSchemaResult<SpecSourceReference> {
  if (!record(value) || !exactKeys(value, ["planSessionId", "planArtifactPath", "planMarkdownPath", "annotationsPath", "planDocumentRevision", "planStateVersion", "planMarkdownSha256", "annotationsSha256", "grillPath", "grillPointer", "grillBasedOnDocumentRevision", "grillStateVersion", "grillDecisionTreeSha256"])) return invalid("invalid-source", "Spec source reference shape is invalid.");
  if (!id(value.planSessionId) || !absolute(value.planArtifactPath)
    || value.planMarkdownPath !== resolve(value.planArtifactPath, "plan.md")
    || value.annotationsPath !== resolve(value.planArtifactPath, "annotations.json")
    || value.grillPath !== resolve(value.planArtifactPath, "grill.json")
    || !positive(value.planDocumentRevision) || !positive(value.planStateVersion) || !positive(value.grillBasedOnDocumentRevision) || !positive(value.grillStateVersion)
    || value.grillBasedOnDocumentRevision !== value.planDocumentRevision || value.grillPointer !== "#/decisionTree"
    || !hash(value.planMarkdownSha256) || !hash(value.annotationsSha256) || !hash(value.grillDecisionTreeSha256)) return invalid("invalid-source", "Spec source reference values are invalid.");
  return { ok: true, value: value as unknown as SpecSourceReference };
}

export function validateSpecTarget(target: unknown, markdown: string, revision: number, expectedHash = sha256Text(markdown)): target is SpecRangeTarget {
  if (!record(target) || !exactKeys(target, ["start", "end", "exact", "prefix", "suffix", "revision", "markdownSha256"])) return false;
  if (!safe(target.start) || !safe(target.end) || target.end <= target.start || target.revision !== revision || target.markdownSha256 !== expectedHash) return false;
  if (typeof target.exact !== "string" || target.exact.length === 0 || points(target.exact) > SPEC_LIMITS.exactCodePoints) return false;
  if (typeof target.prefix !== "string" || points(target.prefix) > SPEC_LIMITS.contextCodePoints || typeof target.suffix !== "string" || points(target.suffix) > SPEC_LIMITS.contextCodePoints) return false;
  return slice(markdown, target.start, target.end) === target.exact
    && slice(markdown, Math.max(0, target.start - points(target.prefix)), target.start) === target.prefix
    && slice(markdown, target.end, target.end + points(target.suffix)) === target.suffix;
}

export function validateSpecSession(value: unknown): SpecSchemaResult<SpecSession> {
  if (!record(value) || !exactKeys(value, ["schemaVersion", "planSessionId", "stateVersion", "specRevision", "status", "source", "markdown", "comments"], ["generationJob", "lastError"]) || value.schemaVersion !== 1
    || !id(value.planSessionId) || !positive(value.stateVersion) || !safe(value.specRevision) || typeof value.status !== "string" || !STATUSES.has(value.status)
    || !Array.isArray(value.comments) || value.comments.length > SPEC_LIMITS.comments || !(value.markdown === null || typeof value.markdown === "string")) return invalid("invalid-session", "Spec session shape is invalid.");
  const source = validateSpecSourceReference(value.source); if (!source.ok || source.value.planSessionId !== value.planSessionId) return invalid("invalid-source", "Spec source correlation is invalid.");
  const session = value as unknown as SpecSession;
  if ((session.specRevision === 0) !== (session.markdown === null)) return invalid("invalid-revision", "Spec revision and Markdown materialization disagree.");
  if (session.markdown !== null && !validateSpecMarkdown(session.markdown).ok) return invalid("invalid-spec", "Committed Spec Markdown is invalid.");
  if (session.markdown === null && session.comments.length > 0) return invalid("invalid-comments", "An empty Spec cannot have comments.");
  if (new Set(session.comments.map((comment) => comment.id)).size !== session.comments.length) return invalid("duplicate-comment", "Spec comment IDs must be unique.");
  if (session.markdown !== null && session.comments.some((comment) => !validComment(comment, session.markdown!, session.specRevision))) return invalid("invalid-comment", "A Spec comment is invalid.");
  if (!validStatus(session)) return invalid("invalid-status", "Spec status and materialization disagree.");
  if (session.generationJob && !validJob(session)) return invalid("invalid-job", "Spec generation correlation is invalid.");
  if (session.lastError && (!record(session.lastError) || !exactKeys(session.lastError, ["code", "message"]) || typeof session.lastError.code !== "string" || typeof session.lastError.message !== "string")) return invalid("invalid-error", "Spec error is invalid.");
  return { ok: true, value: session };
}

function validStatus(session: SpecSession): boolean {
  if ((session.status === "generating") !== (session.generationJob?.operation === "initial")) return false;
  if ((session.status === "revising") !== (session.generationJob?.operation === "revision")) return false;
  if (["ready", "revising", "accepted"].includes(session.status) && session.markdown === null) return false;
  return !(session.status === "paused" && session.generationJob);
}
function validJob(session: SpecSession): boolean {
  const job = session.generationJob!;
  return record(job) && exactKeys(job, ["jobId", "operation", "baseSpecRevision", "selectedCommentIds", "source", "startedAt"], ["instruction"])
    && id(job.jobId) && (job.operation === "initial" || job.operation === "revision") && job.baseSpecRevision === session.specRevision
    && Array.isArray(job.selectedCommentIds) && job.selectedCommentIds.every(id) && new Set(job.selectedCommentIds).size === job.selectedCommentIds.length
    && job.selectedCommentIds.every((commentId) => session.comments.some((comment) => comment.id === commentId && comment.status === "open"))
    && JSON.stringify(job.source) === JSON.stringify(session.source) && timestamp(job.startedAt)
    && (job.instruction === undefined || typeof job.instruction === "string" && Buffer.byteLength(job.instruction, "utf8") <= SPEC_LIMITS.instructionBytes);
}
function validComment(comment: SpecComment, markdown: string, revision: number): boolean {
  if (!record(comment) || !exactKeys(comment, ["id", "target", "originalTarget", "body", "status", "history", "createdAt", "updatedAt"], ["statusBeforeOrphan"]) || !id(comment.id)
    || typeof comment.body !== "string" || comment.body.trim().length === 0 || points(comment.body) > SPEC_LIMITS.commentBodyCodePoints
    || typeof comment.status !== "string" || !COMMENT_STATUSES.has(comment.status) || !Array.isArray(comment.history)
    || !timestamp(comment.createdAt) || !timestamp(comment.updatedAt)) return false;
  if (!record(comment.originalTarget) || !targetShape(comment.originalTarget)) return false;
  if (!comment.history.every((entry) => record(entry) && exactKeys(entry, ["from", "to", "at"]) && COMMENT_STATUSES.has(String(entry.from)) && COMMENT_STATUSES.has(String(entry.to)) && timestamp(entry.at))) return false;
  if (comment.status === "orphaned") return (comment.statusBeforeOrphan === "open" || comment.statusBeforeOrphan === "dismissed") && targetShape(comment.target);
  if (comment.status === "addressed") return comment.statusBeforeOrphan === undefined && targetShape(comment.target);
  return comment.statusBeforeOrphan === undefined && validateSpecTarget(comment.target, markdown, revision);
}
function targetShape(value: unknown): boolean {
  return record(value) && exactKeys(value, ["start", "end", "exact", "prefix", "suffix", "revision", "markdownSha256"]) && safe(value.start) && safe(value.end) && value.end > value.start
    && typeof value.exact === "string" && value.exact.length > 0 && typeof value.prefix === "string" && typeof value.suffix === "string" && safe(value.revision) && hash(value.markdownSha256);
}
export function sha256Text(value: string): string { return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex"); }
export function codePoints(value: string): readonly string[] { return [...value]; }
function points(value: string): number { return [...value].length; }
function slice(value: string, start: number, end: number): string { return [...value].slice(start, end).join(""); }
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean { const keys = Object.keys(value); return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key)); }
function safe(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return safe(value) && value >= 1; }
function id(value: unknown): value is string { return typeof value === "string" && /^[!-~]{1,64}$/u.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function absolute(value: unknown): value is string { return typeof value === "string" && !value.includes("\0") && isAbsolute(value) && resolve(value) === value; }
function timestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && new Date(value).toISOString() === value; }
function invalid<T>(code: string, message: string): SpecSchemaResult<T> { return { ok: false, issues: [{ path: "$", code, message }] }; }
