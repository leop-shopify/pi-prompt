import { describe, expect, it } from "vitest";
import {
  PLAN_LIMITS, validateInitialPlanResult, validatePlanSession, validateRevisionPlanResult,
} from "../plan/schema.js";
import type { Annotation, PlanElement, PlanSession } from "../plan/types.js";

const NOW = "2026-07-10T12:00:00.000Z";
const sessionId = "ps_session01";
const documentId = "pd_document01";
const titleId = "pe_title0001";
const executionId = "pe_execute01";
const stepId = "pe_step00001";
const annotationId = "an_comment001";

const execution = (): PlanElement => ({ id: executionId, kind: "execution", body: "Run this plan normally.", children: [] });
const validSession = (): PlanSession => ({
  schemaVersion: 1, id: sessionId, documentRevision: 1, stateVersion: 1, status: "ready",
  source: { prompt: "Build it", cwd: "/workspace", skills: [{ name: "test-expert", path: "/skills/test/SKILL.md", baseDir: "/skills/test", sha256: "a".repeat(64) }] },
  execution: { kind: "normal" }, generation: { mode: "normal" },
  document: {
    id: documentId,
    title: { id: titleId, kind: "title", body: "Canonical plan", children: [] },
    elements: [execution(), { id: stepId, kind: "step", title: "Implement", body: "Make the focused change.", children: [] }],
  },
  annotations: [],
});

function rangeAnnotation(overrides: Partial<Annotation> = {}): Annotation {
  const selector = { field: "body" as const, start: 5, end: 8, exact: "the", prefix: "e ", suffix: " fo" };
  return {
    id: annotationId,
    target: { kind: "range", elementId: stepId, selector },
    targetSnapshot: { documentRevision: 1, target: { kind: "range", elementId: stepId, selector }, elementKind: "step", text: "Make the focused change." },
    body: "Clarify this.", status: "open", history: [], createdAgainstRevision: 1, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}
function withAnnotations(session: PlanSession, annotations: readonly Annotation[]): PlanSession {
  return { ...session, annotations } as PlanSession;
}
function expectInvalid(value: unknown, code?: string): void {
  const result = validatePlanSession(value); expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
}

describe("canonical plan validation", () => {
  it("normalizes to a fresh deeply frozen session and keeps SafeError to code and message", () => {
    const input = { ...validSession(), lastError: { code: "temporary", message: "Try\r\nagain" } };
    const result = validatePlanSession(input); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.value).not.toBe(input); expect(result.value.lastError).toEqual({ code: "temporary", message: "Try\nagain" });
    expect(Object.isFrozen(result.value.document)).toBe(true);
    expectInvalid({ ...input, lastError: { ...input.lastError, retryable: true } }, "invalid-structure");
  });

  it("persists create-goal as an exclusive execution kind", () => {
    const result = validatePlanSession({ ...validSession(), execution: { kind: "create-goal" } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.execution).toEqual({ kind: "create-goal" });
    expectInvalid({ ...validSession(), execution: { kind: "create-goalie" } }, "invalid-structure");
  });

  it("enforces empty/materialized revision invariants", () => {
    const empty = { ...validSession(), status: "generating", documentRevision: 0, document: null, annotations: [], generationJob: { jobId: "job-1", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: NOW } };
    expect(validatePlanSession(empty).ok).toBe(true);
    expectInvalid({ ...empty, documentRevision: 1 }, "empty-revision"); expectInvalid({ ...validSession(), documentRevision: 0 }, "materialized-revision");
  });

  it("strictly binds generation jobs and pending actions to their statuses", () => {
    const generating = { ...validSession(), status: "generating", documentRevision: 0, document: null, annotations: [], generationJob: { jobId: "job-1", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], instruction: "x".repeat(PLAN_LIMITS.generationInstructionBytes), startedAt: NOW } };
    expect(validatePlanSession(generating).ok).toBe(true);
    expectInvalid({ ...generating, generationJob: undefined }, "missing-job");
    expectInvalid({ ...generating, generationJob: { ...generating.generationJob, extra: true } }, "invalid-structure");
    expectInvalid({ ...generating, generationJob: { ...generating.generationJob, instruction: "x".repeat(PLAN_LIMITS.generationInstructionBytes + 1) } }, "too-long");
    expectInvalid({ ...validSession(), generationJob: { ...generating.generationJob, operation: "revision", baseDocumentRevision: 1 } }, "job-status");
    const needsInput = { ...generating, status: "needs-input", generationJob: undefined, lastError: { code: "skill-context-changed", message: "Selected skill context changed." } };
    expect(validatePlanSession(needsInput).ok).toBe(true);
    expectInvalid({ ...needsInput, lastError: undefined }, "missing-error");
  });

  it("enforces bounded clarification rounds, questions, options, origins, and exact answers", () => {
    const question = { id: "question-1", prompt: "Which target?", options: [{ id: "option-1", label: "One" }, { id: "option-2", label: "Two" }] };
    const pending = { id: "round-1", operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: [], questions: [question] };
    const waiting = { ...validSession(), status: "awaiting-clarification" as const, clarifications: { history: [], origin: { operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: [] }, pending } };
    expect(validatePlanSession(waiting).ok).toBe(true);
    expectInvalid({ ...waiting, clarifications: { ...waiting.clarifications, pending: { ...pending, questions: [] } } }, "invalid-structure");
    expectInvalid({ ...waiting, clarifications: { ...waiting.clarifications, pending: { ...pending, questions: [{ ...question, options: [question.options[0]] }] } } }, "invalid-structure");
    expectInvalid({ ...waiting, clarifications: { ...waiting.clarifications, origin: { ...waiting.clarifications.origin, baseDocumentRevision: 0 } } }, "origin-mismatch");
    const answered = { id: "answered", questions: [question], answers: [{ questionId: question.id, answer: { kind: "option" as const, optionId: "missing" } }], answeredAt: NOW };
    expectInvalid({ ...validSession(), clarifications: { history: [answered] } }, "unknown-option");
    const rounds = Array.from({ length: PLAN_LIMITS.clarificationRounds }, (_, index) => ({ id: `round-${index}`, questions: [{ id: `question-${index}`, prompt: "Prompt?", options: [{ id: `a-${index}`, label: "A" }, { id: `b-${index}`, label: "B" }] }], answers: [{ questionId: `question-${index}`, answer: { kind: "custom" as const, text: "Answer" } }], answeredAt: NOW }));
    expect(validatePlanSession({ ...validSession(), clarifications: { history: rounds } }).ok).toBe(true);
    expectInvalid({ ...waiting, clarifications: { ...waiting.clarifications, history: rounds } }, "too-many-rounds");
  });

  it("accepts generic printable ASCII IDs and rejects spaces and lengths outside 1..64", () => {
    expect(validatePlanSession({ ...validSession(), id: documentId }).ok).toBe(true);
    const crossPrefix = validSession(); (crossPrefix.document!.elements[1] as { id: string }).id = annotationId; expect(validatePlanSession(crossPrefix).ok).toBe(true);
    expectInvalid({ ...validSession(), id: "has space" }, "invalid-structure");
    expectInvalid({ ...validSession(), id: "" }, "invalid-structure");
    expect(validatePlanSession({ ...validSession(), id: "x".repeat(PLAN_LIMITS.idAscii) }).ok).toBe(true);
    expectInvalid({ ...validSession(), id: "x".repeat(PLAN_LIMITS.idAscii + 1) }, "invalid-structure");
  });

  it("uses exact Unicode code-point caps for source, paths, errors, and selector context", () => {
    const exact = validSession(); (exact.source as { prompt: string; cwd: string }).prompt = "😀".repeat(PLAN_LIMITS.sourcePromptCodePoints); (exact.source as { cwd: string }).cwd = "x".repeat(PLAN_LIMITS.pathCodePoints); expect(validatePlanSession(exact).ok).toBe(true);
    expectInvalid({ ...validSession(), source: { ...validSession().source, prompt: "x".repeat(PLAN_LIMITS.sourcePromptCodePoints + 1) } }, "too-long");
    expectInvalid({ ...validSession(), source: { ...validSession().source, cwd: "x".repeat(PLAN_LIMITS.pathCodePoints + 1) } }, "too-long");
    expectInvalid({ ...validSession(), lastError: { code: "e", message: "x".repeat(PLAN_LIMITS.safeErrorMessageCodePoints + 1) } }, "too-long");
    const context = "x".repeat(PLAN_LIMITS.selectorContextCodePoints); const selected = `${context}z`;
    const exactContext = rangeAnnotation({ target: { kind: "range", elementId: stepId, selector: { field: "body", start: PLAN_LIMITS.selectorContextCodePoints, end: PLAN_LIMITS.selectorContextCodePoints + 1, exact: "z", prefix: context } }, targetSnapshot: { documentRevision: 1, target: { kind: "range", elementId: stepId, selector: { field: "body", start: PLAN_LIMITS.selectorContextCodePoints, end: PLAN_LIMITS.selectorContextCodePoints + 1, exact: "z", prefix: context } }, elementKind: "step", text: selected } });
    const contextSession = validSession(); (contextSession.document!.elements[1] as { body: string }).body = selected; expect(validatePlanSession(withAnnotations(contextSession, [exactContext])).ok).toBe(true);
    const tooMuchContext = `${context}x`; const invalidContext = structuredClone(exactContext); (invalidContext.target as { selector: { prefix: string } }).selector.prefix = tooMuchContext; (invalidContext.targetSnapshot.target as { selector: { prefix: string } }).selector.prefix = tooMuchContext; expectInvalid(withAnnotations(contextSession, [invalidContext]), "too-long");
  });

  it("enforces exact/+1 skill and annotation collection caps", () => {
    const skill = validSession().source.skills[0];
    const exactSkills = { ...validSession(), source: { ...validSession().source, skills: Array.from({ length: PLAN_LIMITS.skills }, (_, index) => ({ ...skill, name: `skill-${index}`, path: `/skill/${index}` })) } }; expect(validatePlanSession(exactSkills).ok).toBe(true);
    expectInvalid({ ...exactSkills, source: { ...exactSkills.source, skills: [...exactSkills.source.skills, { ...skill, name: "extra", path: "/extra" }] } }, "invalid-structure");
    const annotations = Array.from({ length: PLAN_LIMITS.annotations }, (_, index) => rangeAnnotation({ id: `an_${String(index).padStart(8, "0")}` })); expect(validatePlanSession(withAnnotations(validSession(), annotations)).ok).toBe(true);
    expectInvalid(withAnnotations(validSession(), [...annotations, rangeAnnotation({ id: "an_extra0001" })]), "invalid-structure");
  });

  it("enforces tree depth, child, element, and plan byte defenses", () => {
    const nested = validSession(); let child: PlanElement = { id: "pe_depth008", kind: "step", body: "x", children: [] };
    for (let depth = 7; depth >= 2; depth -= 1) child = { id: `pe_depth00${depth}`, kind: "step", body: "x", children: [child] };
    (nested.document!.elements[1] as unknown as { children: readonly PlanElement[] }).children = [child]; expect(validatePlanSession(nested).ok).toBe(true);
    const tooDeep = structuredClone(nested) as PlanSession; const depthTwo = tooDeep.document!.elements[1]!.children[0]!; (depthTwo.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!.children[0] as unknown as { children: PlanElement[] }).children = [{ id: "pe_depth009", kind: "step", body: "x", children: [] }]; expectInvalid(tooDeep, "too-deep");
    const children = validSession(); (children.document!.elements[1] as unknown as { children: PlanElement[] }).children = Array.from({ length: PLAN_LIMITS.children + 1 }, (_, index) => ({ id: `pe_child${String(index).padStart(5, "0")}`, kind: "step", body: "x", children: [] })); expectInvalid(children, "invalid-structure");
    const elementBoundary = validSession();
    const top = Array.from({ length: PLAN_LIMITS.children }, (_, index): PlanElement => ({ id: index === 0 ? executionId : `pe_top${String(index).padStart(5, "0")}`, kind: index === 0 ? "execution" : "step", body: "x", children: [] }));
    for (const [topIndex, childCount] of [[1, 64], [2, 64], [3, 63]] as const) (top[topIndex] as unknown as { children: PlanElement[] }).children = Array.from({ length: childCount }, (_, index) => ({ id: `pe_node${topIndex}${String(index).padStart(4, "0")}`, kind: "step", body: "x", children: [] }));
    (elementBoundary.document as unknown as { elements: PlanElement[] }).elements = top; expect(validatePlanSession(elementBoundary).ok).toBe(true);
    (top[3] as unknown as { children: PlanElement[] }).children = [...top[3]!.children, { id: "pe_node30063", kind: "step", body: "x", children: [] }]; expectInvalid(elementBoundary, "too-many-elements");
    const bytes = validSession(); (bytes.document!.elements[1] as unknown as { children: PlanElement[] }).children = Array.from({ length: 20 }, (_, index) => ({ id: `pe_bytes${String(index).padStart(5, "0")}`, kind: "step", body: "x".repeat(PLAN_LIMITS.bodyCodePoints), children: [] })); expectInvalid(bytes, "plan-too-large");
  });

  it("binds root annotations to the document using the uniform elementId shape", () => {
    const root: Annotation = { id: annotationId, target: { kind: "root", elementId: documentId }, targetSnapshot: { documentRevision: 1, target: { kind: "root", elementId: documentId }, elementKind: "root", text: "" }, body: "Document note", status: "open", history: [], createdAgainstRevision: 1, createdAt: NOW, updatedAt: NOW };
    expect(validatePlanSession(withAnnotations(validSession(), [root])).ok).toBe(true);
    expectInvalid(withAnnotations(validSession(), [{ ...root, target: { kind: "root", elementId: "pd_other0001" } }]), "unknown-target");
    const laterRevision = { ...validSession(), documentRevision: 2 } as PlanSession;
    expectInvalid(withAnnotations(laterRevision, [{ ...root, target: { kind: "root", elementId: "other-root" }, targetSnapshot: { ...root.targetSnapshot, target: { kind: "root", elementId: "other-root" } } }]), "unknown-target");
    const legacy = structuredClone(root) as unknown as Record<string, unknown>; legacy.target = { kind: "root", documentId }; expectInvalid(withAnnotations(validSession(), [legacy as unknown as Annotation]), "invalid-structure");
  });

  it("requires immutable snapshot provenance and current-revision fidelity", () => {
    expect(validatePlanSession(withAnnotations(validSession(), [rangeAnnotation()])).ok).toBe(true);
    expectInvalid(withAnnotations(validSession(), [rangeAnnotation({ targetSnapshot: { ...rangeAnnotation().targetSnapshot, documentRevision: 2 } })]), "snapshot-revision");
    expectInvalid(withAnnotations(validSession(), [rangeAnnotation({ targetSnapshot: { ...rangeAnnotation().targetSnapshot, text: "stale" } })]), "snapshot-fidelity");
    const elementNote: Annotation = { ...rangeAnnotation(), target: { kind: "element", elementId: stepId }, targetSnapshot: { documentRevision: 1, target: { kind: "element", elementId: stepId }, elementKind: "step", text: "Implement\nMake the focused change." } };
    expect(validatePlanSession(withAnnotations(validSession(), [elementNote])).ok).toBe(true);
  });

  it("matches non-orphan ranges to current text but orphan ranges only to faithful historical snapshots", () => {
    const stale = rangeAnnotation({ status: "orphaned", statusBeforeOrphan: "open", history: [{ from: "open", to: "orphaned", at: NOW }] });
    const revised = { ...validSession(), documentRevision: 2 } as PlanSession; (revised.document!.elements[1] as { body: string }).body = "Completely revised.";
    expect(validatePlanSession(withAnnotations(revised, [stale])).ok).toBe(true);
    const reopened = { ...stale, status: "open", history: [] } as { statusBeforeOrphan?: "open"; status: "open"; history: readonly [] } & Annotation;
    delete reopened.statusBeforeOrphan;
    expectInvalid(withAnnotations(revised, [reopened]), "quote-mismatch");
    expectInvalid(withAnnotations(revised, [{ ...stale, targetSnapshot: { ...stale.targetSnapshot, text: "short" } }]), "invalid-range");
    const missing = structuredClone(revised) as PlanSession; (missing.document as { elements: readonly PlanElement[] }).elements = [execution()]; expect(validatePlanSession(withAnnotations(missing, [stale])).ok).toBe(true);
  });

  it("validates bounded, continuous history entries shaped as from/to/at", () => {
    const history = [
      { from: "open" as const, to: "addressed" as const, at: "2026-07-10T12:01:00.000Z" },
      { from: "addressed" as const, to: "dismissed" as const, at: "2026-07-10T12:02:00.000Z" },
      { from: "dismissed" as const, to: "orphaned" as const, at: "2026-07-10T12:03:00.000Z" },
    ];
    const annotation = rangeAnnotation({ status: "orphaned", statusBeforeOrphan: "dismissed", history, updatedAt: "2026-07-10T12:03:00.000Z" }); expect(validatePlanSession(withAnnotations(validSession(), [annotation])).ok).toBe(true);
    const speculativeHistory = [{ ...history[0], actor: "model" }, ...history.slice(1)] as unknown as Annotation["history"];
    expectInvalid(withAnnotations(validSession(), [{ ...annotation, history: speculativeHistory }]), "invalid-structure");
    const maxHistory = Array.from({ length: PLAN_LIMITS.history }, (_, index) => ({ from: index % 2 === 0 ? "open" as const : "addressed" as const, to: index % 2 === 0 ? "addressed" as const : "open" as const, at: NOW }));
    expect(validatePlanSession(withAnnotations(validSession(), [rangeAnnotation({ status: "open", history: maxHistory })])).ok).toBe(true);
    expectInvalid(withAnnotations(validSession(), [rangeAnnotation({ status: "addressed", history: [...maxHistory, { from: "open", to: "addressed", at: NOW }] })]), "invalid-structure");
  });
});

describe("model result drafts", () => {
  const document = () => ({ title: { kind: "title", body: "Plan", children: [] }, elements: [{ kind: "execution", body: "Normal execution.", children: [] }] });

  it("accepts optional generic retained IDs on revision documents and elements", () => {
    expect(validateInitialPlanResult({ kind: "plan", document: document() }).ok).toBe(true);
    const result = validateRevisionPlanResult({ kind: "revision", document: { ...document(), retainedId: documentId, title: { ...document().title, retainedId: annotationId } }, addressedAnnotationIds: [] });
    expect(result.ok).toBe(true); if (result.ok) expect(result.value.document).toMatchObject({ retainedId: documentId, title: { retainedId: annotationId } });
    expect(validateRevisionPlanResult({ kind: "revision", document: { ...document(), retainedId: "has space" }, addressedAnnotationIds: [] }).ok).toBe(false);
  });

  it("bounds addressed IDs and whole result JSON bytes", () => {
    const ids = Array.from({ length: PLAN_LIMITS.annotations }, (_, index) => `an_${String(index).padStart(8, "0")}`);
    expect(validateRevisionPlanResult({ kind: "revision", document: document(), addressedAnnotationIds: ids }).ok).toBe(true);
    expect(validateRevisionPlanResult({ kind: "revision", document: document(), addressedAnnotationIds: [...ids, "an_extra0001"] }).ok).toBe(false);
    const oversized = validateInitialPlanResult({ kind: "plan", document: { ...document(), title: { kind: "title", body: "x".repeat(PLAN_LIMITS.maxJsonBytes), children: [] } } });
    expect(oversized.ok).toBe(false); if (!oversized.ok) expect(oversized.issues[0]?.code).toBe("json-too-large");
  });
});
