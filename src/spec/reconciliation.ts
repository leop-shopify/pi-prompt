import { SPEC_LIMITS, codePoints, sha256Text, validateSpecTarget } from "./schema.js";
import type { SpecComment, SpecRangeTarget, SpecResult } from "./types.js";

export interface ReconcileSpecRevisionInput {
  readonly previousMarkdown: string;
  readonly nextMarkdown: string;
  readonly previousRevision: number;
  readonly comments: readonly SpecComment[];
  readonly selectedCommentIds: readonly string[];
  readonly addressedCommentIds: readonly string[];
  readonly now: string;
}

export function createSpecRangeTarget(markdown: string, revision: number, start: number, end: number): SpecResult<SpecRangeTarget> {
  const chars = codePoints(markdown);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > chars.length) return failure("invalid-selection", "The selected Spec range is invalid.");
  const exact = chars.slice(start, end).join("");
  if (!exact || exact.trim().length === 0 || Buffer.byteLength(markdown, "utf8") > SPEC_LIMITS.markdownBytes || [...exact].length > SPEC_LIMITS.exactCodePoints) return failure("invalid-selection", "The selected Spec text is invalid.");
  return success(Object.freeze({
    start, end, exact,
    prefix: chars.slice(Math.max(0, start - SPEC_LIMITS.contextCodePoints), start).join(""),
    suffix: chars.slice(end, end + SPEC_LIMITS.contextCodePoints).join(""),
    revision, markdownSha256: sha256Text(markdown),
  }));
}

/** Re-anchors only unambiguous quotes. Unresolved or ambiguous comments orphan without guessing. */
export function reconcileSpecRevision(input: ReconcileSpecRevisionInput): SpecResult<readonly SpecComment[]> {
  if (input.nextMarkdown === input.previousMarkdown) return failure("no-op-revision", "A Spec revision must change the exact Markdown bytes.");
  const selected = new Set(input.selectedCommentIds); const addressed = new Set(input.addressedCommentIds);
  if (selected.size !== input.selectedCommentIds.length || addressed.size !== input.addressedCommentIds.length || [...addressed].some((id) => !selected.has(id))) return failure("invalid-addressed-comments", "Only selected comments may be addressed by a revision.");
  if ([...selected].some((id) => !input.comments.some((comment) => comment.id === id && comment.status === "open"))) return failure("invalid-selected-comments", "Selected comments must be current and open.");
  const nextRevision = input.previousRevision + 1;
  return success(Object.freeze(input.comments.map((comment) => {
    if (addressed.has(comment.id)) return transition({ ...comment, target: reanchor(comment.target, input.nextMarkdown, nextRevision) ?? comment.target, statusBeforeOrphan: undefined }, "addressed", input.now);
    if (comment.status === "addressed") return comment;
    const target = reanchor(comment.target, input.nextMarkdown, nextRevision);
    if (target) {
      if (comment.status !== "orphaned") return { ...comment, target };
      const restored = comment.statusBeforeOrphan ?? "open";
      return transition({ ...comment, target, statusBeforeOrphan: undefined }, restored, input.now);
    }
    if (comment.status === "orphaned") return comment;
    const before = comment.status === "dismissed" ? "dismissed" : "open";
    return transition({ ...comment, statusBeforeOrphan: before }, "orphaned", input.now);
  })));
}

function reanchor(target: SpecRangeTarget, markdown: string, revision: number): SpecRangeTarget | null {
  const chars = codePoints(markdown); const quote = codePoints(target.exact); const starts: number[] = [];
  for (let start = 0; start <= chars.length - quote.length; start += 1) {
    if (chars.slice(start, start + quote.length).join("") !== target.exact) continue;
    const prefix = codePoints(target.prefix); const suffix = codePoints(target.suffix);
    const prefixMatches = chars.slice(Math.max(0, start - prefix.length), start).join("") === target.prefix;
    const suffixMatches = chars.slice(start + quote.length, start + quote.length + suffix.length).join("") === target.suffix;
    if (prefixMatches && suffixMatches) starts.push(start);
  }
  if (starts.length !== 1) return null;
  const made = createSpecRangeTarget(markdown, revision, starts[0]!, starts[0]! + quote.length);
  return made.ok && validateSpecTarget(made.value, markdown, revision) ? made.value : null;
}
function transition(comment: SpecComment, status: SpecComment["status"], at: string): SpecComment {
  if (comment.status === status) return comment;
  return { ...comment, status, history: [...comment.history, { from: comment.status, to: status, at }], updatedAt: at };
}
function success<T>(value: T): SpecResult<T> { return { ok: true, value }; }
function failure<T = never>(code: string, message: string): SpecResult<T> { return { ok: false, error: { code, message } }; }
