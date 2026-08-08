import { parseStrictJsonObject } from "./raw-json.js";
import { PLAN_LIMITS, validateClarificationQuestions, validateGrillResult, validateInitialPlanResult, validatePlanSession } from "./schema.js";
import type {
  ClarificationQuestion, ClarificationResultDraft, GrillResultDraft, InitialPlanResultDraft, ModelPlanDocumentDraft,
  ModelRevisionPlanDocumentDraft, PlanOperation, PlanSession, RevisionMarkdownResultDraft, SafeError, ValidationResult,
} from "./types.js";

export type { PlanOperation } from "./types.js";

export interface PlanGeneratorInput {
  readonly session: PlanSession;
  readonly jobId: string;
  readonly operation: PlanOperation;
  readonly selectedAnnotationIds: readonly string[];
  readonly instruction?: string;
  readonly signal: AbortSignal;
}

export type PlanGeneratorOutcome =
  | (InitialPlanResultDraft & { readonly markdown?: string })
  | RevisionMarkdownResultDraft
  | GrillResultDraft
  | ClarificationResultDraft;
export type PlanGeneratorResult =
  | { readonly ok: true; readonly outcome: PlanGeneratorOutcome }
  | { readonly ok: false; readonly error: SafeError };

export type PlanDispatchResult = { readonly ok: true; readonly value: undefined } | { readonly ok: false; readonly error: SafeError };
export type WriterSubmissionKind = "plan" | "clarification" | "grill";
export interface WriterSubmissionInput {
  readonly sessionId: string;
  readonly jobId: string;
  readonly operation: PlanOperation;
  readonly baseDocumentRevision: number;
  readonly attemptId: string;
  readonly kind: WriterSubmissionKind;
  readonly body: Buffer;
}
export interface DispatchablePlanGenerator {
  generate(input: PlanGeneratorInput): Promise<PlanGeneratorResult>;
  configureWriterEndpoint(url: string): PlanDispatchResult;
  submitWriterResult(input: WriterSubmissionInput): Promise<PlanDispatchResult>;
  dispatch(jobId: string): PlanDispatchResult;
  close(): void | Promise<void>;
}

export function validateGeneratorInput(input: PlanGeneratorInput): ValidationResult<PlanSession> {
  const session = validatePlanSession(input.session);
  if (!session.ok) return session;
  const job = session.value.generationJob;
  if (!job || job.jobId !== input.jobId || job.operation !== input.operation
    || job.baseDocumentRevision !== session.value.documentRevision
    || !sameStrings(job.selectedAnnotationIds, input.selectedAnnotationIds)
    || job.instruction !== input.instruction) return invalid("invalid-generator-input", "The plan generation correlation is invalid.");
  if ((input.operation === "revision" || input.operation === "grill") && !session.value.document) return invalid("invalid-generator-input", "Revision and Adversarial Review generation require a current plan.");
  return session;
}

/** Parses one complete primary report and validates that exact structured result without synthesis or fabrication. */
export function parseGeneratorReport(
  report: string, operation: PlanOperation, session: PlanSession,
): PlanGeneratorResult {
  const parsed = parseStrictJsonObject(report, { maxBytes: PLAN_LIMITS.maxJsonBytes, maxDepth: PLAN_LIMITS.depth + 6 });
  if (!parsed.ok) return failed("invalid-generation-report", `The primary planner report is not one complete JSON result: ${formatIssues(parsed.issues)}`);
  return validateGeneratorSubmission(parsed.value, operation, session);
}

/** Strict schema and minimum execution-artifact validation for bridge submissions. */
export function validateGeneratorSubmission(
  input: unknown, operation: PlanOperation, session: PlanSession,
): PlanGeneratorResult {
  if (operation === "revision") {
    if (!isRevisionMarkdownResult(input)) return failed("invalid-generation-result", "A revision submission must contain exactly kind revision-markdown and the exact Markdown bytes decoded as text.");
    return validateRevisionMarkdown(input.markdown);
  }
  if (operation === "grill") return failed("invalid-generation-result", "Adversarial Review submissions require the internal review-result validator.");
  const parsed = validateInitialPlanResult(input);
  if (!parsed.ok) return failed("invalid-generation-result", `The submitted plan is invalid: ${formatIssues(parsed.issues)}`);
  if (!hasImplementationTasks(parsed.value.document)) return failed("missing-implementation-tasks", "The submitted plan omitted valid Implementation Tasks.");
  return { ok: true, outcome: parsed.value };
}

export function validateRevisionMarkdown(markdown: string): PlanGeneratorResult {
  return { ok: true, outcome: { kind: "revision-markdown", markdown } };
}

export function validateGrillSubmission(input: unknown, session: PlanSession): PlanGeneratorResult {
  const parsed = validateGrillResult(input);
  if (!parsed.ok) return failed("invalid-grill", `The Adversarial Review submission is invalid: ${formatIssues(parsed.issues)}`);
  if (!session.document || parsed.value.basedOnDocumentRevision !== session.documentRevision) return failed("stale-grill", "The Adversarial Review submission does not match the current plan revision.");
  return { ok: true, outcome: parsed.value };
}

export function validateClarificationSubmission(input: unknown): PlanGeneratorResult {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("questions" in input)) {
    return failed("invalid-clarification", "The clarification submission must contain exactly one questions field.");
  }
  const questions = validateClarificationQuestions((input as { readonly questions?: unknown }).questions);
  if (!questions.ok) return failed("invalid-clarification", `The clarification submission is invalid: ${formatIssues(questions.issues)}`);
  return { ok: true, outcome: { kind: "clarification", questions: questions.value } };
}

export function clarificationOutcome(questions: readonly ClarificationQuestion[]): PlanGeneratorResult {
  return { ok: true, outcome: { kind: "clarification", questions } };
}

export function operationContract(operation: PlanOperation): string {
  const element = '{"kind":"title","body":"Plan title","children":[]}';
  if (operation === "grill") return [
    "Submit exactly this JSON shape (replace example values): {\"kind\":\"grill\",\"basedOnDocumentRevision\":1,\"annotations\":{\"risk\":{\"target\":{\"kind\":\"range\",\"elementId\":\"anchor-id\",\"field\":\"body\",\"start\":0,\"end\":4},\"body\":\"State the concern.\"}},\"decisionTree\":{\"nodes\":[{\"id\":\"root\",\"question\":\"Proceed?\",\"annotationKeys\":[\"risk\"],\"options\":[{\"id\":\"yes\",\"label\":\"Yes\",\"decision\":\"Proceed.\"},{\"id\":\"no\",\"label\":\"No\",\"decision\":\"Revise.\"}]}]}}",
    "Range targets may use that flat field/start/end shorthand or the canonical selector form. Do not copy exact/prefix/suffix text already present in the Plan; the controller derives it from Unicode code-point offsets.",
    "Omit rootNodeId only when the nextNodeId edges have exactly one zero-indegree root. Every annotation key appears exactly once; options contain exactly one nextNodeId or decision; nodes are reachable and acyclic. No findings is annotations {} with decisionTree {nodes:[]}.",
    "Use only IDs from the supplied anchor map. Do not modify the plan document.",
  ].join("\n");
  if (operation === "initial") return [
    `Submit exactly {"kind":"plan","document":{"title":${element},"elements":[]}} with the elements populated.`,
    "document.title is a complete title element object, never a string.",
    "Every element is {kind,title?,body,children}; omit all server IDs in an initial result.",
  ].join("\n");
  return [
    "Submit the complete revised plan as Markdown.",
    "The exact decoded Markdown is authoritative; do not submit a structured document, retained IDs, or addressed annotation IDs.",
  ].join("\n");
}

export const IMPLEMENTATION_TASK_CONTRACT = [
  "The document must contain a milestone titled exactly \"Implementation Tasks\" with at least one step child.",
  "Every direct task step needs a nonblank title and body lines beginning `Scope:`, `Test first:`, `Implement:`, `Verify:`, and `Done when:`.",
  `Use only these element kinds and remain within controller limits (maximum ${PLAN_LIMITS.elements} elements, depth ${PLAN_LIMITS.depth}).`,
].join("\n");

function isRevisionMarkdownResult(input: unknown): input is RevisionMarkdownResultDraft {
  return Boolean(input && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).length === 2
    && (input as { readonly kind?: unknown }).kind === "revision-markdown"
    && typeof (input as { readonly markdown?: unknown }).markdown === "string");
}

function hasImplementationTasks(document: ModelPlanDocumentDraft | ModelRevisionPlanDocumentDraft): boolean {
  let section: ModelPlanDocumentDraft["title"] | ModelRevisionPlanDocumentDraft["title"] | undefined;
  const visit = (element: ModelPlanDocumentDraft["title"] | ModelRevisionPlanDocumentDraft["title"]): void => {
    if (element.kind === "milestone" && element.title === "Implementation Tasks") section = element;
    element.children.forEach(visit);
  };
  visit(document.title); document.elements.forEach(visit);
  if (!section || section.children.length === 0) return false;
  const labels = ["Scope:", "Test first:", "Implement:", "Verify:", "Done when:"];
  return section.children.every((task) => task.kind === "step" && Boolean(task.title?.trim())
    && labels.every((label) => new RegExp(`^\\s*${label}\\s*\\S`, "mu").test(task.body)));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function invalid<T>(code: string, message: string): ValidationResult<T> { return { ok: false, issues: [{ path: "$", code, message }] }; }
function formatIssues(issues: readonly { readonly path: string; readonly code: string; readonly message: string }[]): string {
  return issues.slice(0, 8).map((entry) => `${entry.path} [${entry.code}] ${entry.message}`).join("; ");
}
function failed(code: string, message: string): PlanGeneratorResult { return { ok: false, error: { code, message } }; }
