import { validateSpecMarkdown } from "./schema.js";
import { sameSpecSource } from "./source.js";
import type { CapturedSpecSource, SpecOperation, SpecResult, SpecSession } from "./types.js";

export interface SpecGeneratorInput {
  readonly session: SpecSession;
  readonly source: CapturedSpecSource;
  readonly jobId: string;
  readonly operation: SpecOperation;
  readonly selectedCommentIds: readonly string[];
  readonly instruction?: string;
  readonly signal: AbortSignal;
}
export type SpecGeneratorResult = { readonly ok: true; readonly markdown: string } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
export interface SpecWriterSubmission { readonly planSessionId: string; readonly jobId: string; readonly operation: SpecOperation; readonly baseSpecRevision: number; readonly attemptId: string; readonly kind: "spec"; readonly body: Buffer }
export interface DispatchableSpecGenerator {
  generate(input: SpecGeneratorInput): Promise<SpecGeneratorResult>;
  configureWriterEndpoint(url: string): SpecResult;
  submitWriterResult(input: SpecWriterSubmission): Promise<SpecResult>;
  dispatch(jobId: string): SpecResult;
  close(): void | Promise<void>;
}
export function validateSpecGeneratorInput(input: SpecGeneratorInput): SpecResult<SpecGeneratorInput> {
  const job = input.session.generationJob;
  if (!job || job.jobId !== input.jobId || job.operation !== input.operation || job.baseSpecRevision !== input.session.specRevision
    || !sameSpecSource(job.source, input.source.reference) || !sameSpecSource(input.session.source, input.source.reference)
    || job.selectedCommentIds.length !== input.selectedCommentIds.length || job.selectedCommentIds.some((id, index) => id !== input.selectedCommentIds[index]) || job.instruction !== input.instruction) return failure("invalid-generator-input", "Spec generation correlation is invalid.");
  return { ok: true, value: input };
}
export function specResultFromBytes(body: Buffer): SpecGeneratorResult {
  let markdown: string; try { markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body); } catch { return failure("invalid-utf8", "Spec result must be exact valid UTF-8 Markdown."); }
  const result = validateSpecMarkdown(markdown); return result.ok ? { ok: true, markdown: result.value } : failure(result.issues[0]?.code ?? "invalid-spec", result.issues[0]?.message ?? "Spec Markdown is invalid.");
}
function failure<T = never>(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } { return { ok: false, error: { code, message } }; }
