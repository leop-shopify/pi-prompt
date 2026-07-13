import { Compile } from "typebox/compile";
import { Check, Errors } from "typebox/value";
import type {
  Annotation, AnnotationHistoryEntry, AnnotationTarget, AnnotationTargetSnapshot, ClarificationAnswerEntry, ClarificationOrigin,
  ClarificationQuestion, ClarificationTranscript, EmptyPlanSession, GrillAnnotationTargetDraft, GrillArtifact, GrillDecisionTreeDraft, GrillResultDraft,
  InitialPlanResultDraft, MaterializedPlanSession, ModelPlanDocumentDraft, ModelPlanElementDraft,
  ModelRevisionPlanDocumentDraft, ModelRevisionPlanElementDraft, PendingClarification, PlanDocument, PlanElement,
  PlanOperation, PlanSession, RevisionPlanResultDraft, SkillReference, TextSelector,
  ValidationIssue, ValidationResult,
} from "./types.js";
import { PLAN_ELEMENT_KINDS } from "./types.js";

const MiB = 1_048_576;
export const PLAN_LIMITS = deepFreeze({
  maxJsonBytes: MiB,
  sessionBytes: MiB,
  planBytes: 262_144,
  elements: 256,
  depth: 8,
  children: 64,
  titleCodePoints: 256,
  bodyCodePoints: 16_384,
  sourcePromptCodePoints: 65_536,
  annotations: 512,
  annotationBodyCodePoints: 8_192,
  history: 32,
  selectorExactCodePoints: 16_384,
  selectorContextCodePoints: 256,
  skills: 32,
  skillNameCodePoints: 128,
  pathCodePoints: 4_096,
  baseDirCodePoints: 4_096,
  safeErrorCodeCodePoints: 64,
  safeErrorMessageCodePoints: 1_024,
  generationInstructionBytes: 16_384,
  clarificationRounds: 16,
  clarificationQuestions: 5,
  clarificationOptions: 6,
  clarificationPromptCodePoints: 1_024,
  clarificationLabelCodePoints: 256,
  clarificationAnswerCodePoints: 4_096,
  committedMarkdownBytes: 512 * 1_024,
  grillResultBytes: 256 * 1_024,
  grillAnnotations: 64,
  grillNodes: 64,
  grillOptions: 6,
  grillDecisionCodePoints: 2_048,
  idAscii: 64,
} as const);

const stringSchema = { type: "string" } as const;
const integerSchema = { type: "integer", minimum: 0 } as const;
const idSchema = { type: "string", pattern: "^[!-~]{1,64}$", maxLength: PLAN_LIMITS.idAscii } as const;

const executionKindSchema = {
  oneOf: ["normal", "goal", "loop"].map((kind) => ({ type: "object", properties: { kind: { const: kind } }, required: ["kind"], additionalProperties: false })),
} as const;
const textSelectorSchema = {
  type: "object",
  properties: { field: { enum: ["title", "body"] }, start: integerSchema, end: integerSchema, exact: stringSchema, prefix: stringSchema, suffix: stringSchema },
  required: ["field", "start", "end", "exact"], additionalProperties: false,
} as const;
const rootTargetSchema = { type: "object", properties: { kind: { const: "root" }, elementId: idSchema }, required: ["kind", "elementId"], additionalProperties: false } as const;
const elementTargetSchema = { type: "object", properties: { kind: { const: "element" }, elementId: idSchema }, required: ["kind", "elementId"], additionalProperties: false } as const;
const rangeTargetSchema = { type: "object", properties: { kind: { const: "range" }, elementId: idSchema, selector: textSelectorSchema }, required: ["kind", "elementId", "selector"], additionalProperties: false } as const;
const shorthandRangeTargetSchema = { type: "object", properties: { kind: { const: "range" }, elementId: idSchema, field: { enum: ["title", "body"] }, start: integerSchema, end: integerSchema }, required: ["kind", "elementId", "field", "start", "end"], additionalProperties: false } as const;
const targetSchema = { oneOf: [rootTargetSchema, elementTargetSchema, rangeTargetSchema] } as const;
const grillTargetSchema = { oneOf: [rootTargetSchema, elementTargetSchema, rangeTargetSchema, shorthandRangeTargetSchema] } as const;
const snapshotSchema = {
  type: "object",
  properties: { documentRevision: { type: "integer", minimum: 1 }, target: targetSchema, elementKind: { enum: ["root", ...PLAN_ELEMENT_KINDS] }, text: stringSchema },
  required: ["documentRevision", "target", "elementKind", "text"], additionalProperties: false,
} as const;
const historySchema = {
  type: "object",
  properties: {
    from: { enum: ["open", "addressed", "dismissed", "orphaned"] }, to: { enum: ["open", "addressed", "dismissed", "orphaned"] }, at: stringSchema,
  },
  required: ["from", "to", "at"], additionalProperties: false,
} as const;
const annotationSchema = {
  type: "object",
  properties: {
    id: idSchema, author: { enum: ["user", "grill"] }, target: targetSchema, targetSnapshot: snapshotSchema, body: stringSchema,
    status: { enum: ["open", "addressed", "dismissed", "orphaned"] }, statusBeforeOrphan: { enum: ["open", "addressed", "dismissed"] },
    history: { type: "array", items: historySchema, maxItems: PLAN_LIMITS.history }, createdAgainstRevision: { type: "integer", minimum: 1 },
    createdAt: stringSchema, updatedAt: stringSchema,
  },
  required: ["id", "target", "targetSnapshot", "body", "status", "history", "createdAgainstRevision", "createdAt", "updatedAt"], additionalProperties: false,
} as const;
const elementDefinition = {
  type: "object",
  properties: { id: idSchema, kind: { enum: PLAN_ELEMENT_KINDS }, title: stringSchema, body: stringSchema, children: { type: "array", items: { $ref: "#/$defs/element" }, maxItems: PLAN_LIMITS.children } },
  required: ["id", "kind", "body", "children"], additionalProperties: false,
} as const;
const planDocumentSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { element: elementDefinition }, type: "object",
  properties: { id: idSchema, title: { $ref: "#/$defs/element" }, elements: { type: "array", items: { $ref: "#/$defs/element" }, maxItems: PLAN_LIMITS.children } },
  required: ["id", "title", "elements"], additionalProperties: false,
} as const;
const grillDecisionOptionSchema = { type: "object", properties: { id: idSchema, label: stringSchema, nextNodeId: idSchema, decision: stringSchema }, required: ["id", "label"], additionalProperties: false } as const;
const grillDecisionNodeSchema = { type: "object", properties: { id: idSchema, question: stringSchema, annotationKeys: { type: "array", items: idSchema, minItems: 1, maxItems: PLAN_LIMITS.grillAnnotations }, options: { type: "array", items: grillDecisionOptionSchema, minItems: 2, maxItems: PLAN_LIMITS.grillOptions } }, required: ["id", "question", "annotationKeys", "options"], additionalProperties: false } as const;
const grillDecisionTreeSchema = { type: "object", properties: { rootNodeId: idSchema, nodes: { type: "array", items: grillDecisionNodeSchema, minItems: 0, maxItems: PLAN_LIMITS.grillNodes } }, required: ["nodes"], additionalProperties: false } as const;
const grillAnnotationDraftSchema = { type: "object", properties: { target: grillTargetSchema, body: stringSchema }, required: ["target", "body"], additionalProperties: false } as const;
export const GRILL_RESULT_SCHEMA = { type: "object", properties: { kind: { const: "grill" }, basedOnDocumentRevision: { type: "integer", minimum: 1 }, annotations: { type: "object", propertyNames: idSchema, additionalProperties: grillAnnotationDraftSchema, maxProperties: PLAN_LIMITS.grillAnnotations }, decisionTree: grillDecisionTreeSchema }, required: ["kind", "basedOnDocumentRevision", "annotations", "decisionTree"], additionalProperties: false } as const;
const grillArtifactSchema = { type: "object", properties: { basedOnDocumentRevision: { type: "integer", minimum: 1 }, annotationIds: { type: "object", propertyNames: idSchema, additionalProperties: idSchema, maxProperties: PLAN_LIMITS.grillAnnotations }, decisionTree: grillDecisionTreeSchema, generatedAt: stringSchema }, required: ["basedOnDocumentRevision", "annotationIds", "decisionTree", "generatedAt"], additionalProperties: false } as const;
const generationSchema = { type: "object", properties: { mode: { enum: ["quick-win", "normal", "careful", "hard-thinker", "fully-orchestrated"] } }, required: ["mode"], additionalProperties: false } as const;
const skillSchema = { type: "object", properties: { name: stringSchema, path: stringSchema, baseDir: stringSchema, sha256: stringSchema }, required: ["name", "path", "baseDir", "sha256"], additionalProperties: false } as const;
const sourceSchema = { type: "object", properties: { prompt: stringSchema, cwd: stringSchema, skills: { type: "array", items: skillSchema, maxItems: PLAN_LIMITS.skills } }, required: ["prompt", "cwd", "skills"], additionalProperties: false } as const;
const safeErrorSchema = { type: "object", properties: { code: stringSchema, message: stringSchema }, required: ["code", "message"], additionalProperties: false } as const;
const originProperties = {
  operation: { enum: ["initial", "revision"] }, baseDocumentRevision: integerSchema,
  selectedAnnotationIds: { type: "array", items: idSchema, maxItems: PLAN_LIMITS.annotations }, instruction: stringSchema,
} as const;
const clarificationOptionSchema = { type: "object", properties: { id: idSchema, label: stringSchema }, required: ["id", "label"], additionalProperties: false } as const;
const clarificationQuestionSchema = { type: "object", properties: { id: idSchema, prompt: stringSchema, options: { type: "array", items: clarificationOptionSchema, minItems: 2, maxItems: PLAN_LIMITS.clarificationOptions } }, required: ["id", "prompt", "options"], additionalProperties: false } as const;
const clarificationQuestionsSchema = { type: "array", items: clarificationQuestionSchema, minItems: 1, maxItems: PLAN_LIMITS.clarificationQuestions } as const;
const clarificationAnswerSchema = { oneOf: [
  { type: "object", properties: { kind: { const: "option" }, optionId: idSchema }, required: ["kind", "optionId"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "custom" }, text: stringSchema }, required: ["kind", "text"], additionalProperties: false },
] } as const;
const clarificationAnswerEntrySchema = { type: "object", properties: { questionId: idSchema, answer: clarificationAnswerSchema }, required: ["questionId", "answer"], additionalProperties: false } as const;
const clarificationOriginSchema = { type: "object", properties: originProperties, required: ["operation", "baseDocumentRevision", "selectedAnnotationIds"], additionalProperties: false } as const;
const pendingClarificationSchema = { type: "object", properties: { id: idSchema, questions: clarificationQuestionsSchema, ...originProperties }, required: ["id", "questions", "operation", "baseDocumentRevision", "selectedAnnotationIds"], additionalProperties: false } as const;
const answeredClarificationSchema = { type: "object", properties: { id: idSchema, questions: clarificationQuestionsSchema, answers: { type: "array", items: clarificationAnswerEntrySchema, minItems: 1, maxItems: PLAN_LIMITS.clarificationQuestions }, answeredAt: stringSchema }, required: ["id", "questions", "answers", "answeredAt"], additionalProperties: false } as const;
const clarificationTranscriptSchema = { type: "object", properties: { history: { type: "array", items: answeredClarificationSchema, maxItems: PLAN_LIMITS.clarificationRounds }, origin: clarificationOriginSchema, pending: pendingClarificationSchema }, required: ["history"], additionalProperties: false } as const;
const generationJobSchema = {
  type: "object", properties: {
    jobId: idSchema, ...originProperties, operation: { enum: ["initial", "revision", "grill"] }, startedAt: stringSchema,
  }, required: ["jobId", "operation", "baseDocumentRevision", "selectedAnnotationIds", "startedAt"], additionalProperties: false,
} as const;
export const PLAN_SESSION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { element: elementDefinition }, type: "object",
  properties: {
    schemaVersion: { const: 1 }, id: idSchema, documentRevision: integerSchema, stateVersion: integerSchema,
    status: { enum: ["generating", "ready", "revising", "grilling", "awaiting-clarification", "accepted", "paused", "cancelled", "error", "needs-input"] }, source: sourceSchema,
    execution: executionKindSchema, generation: generationSchema, generationJob: generationJobSchema,
    committedMarkdown: stringSchema, clarifications: clarificationTranscriptSchema, grill: grillArtifactSchema,
    document: { anyOf: [{ type: "null" }, { ...planDocumentSchema, $schema: undefined, $defs: undefined }] },
    annotations: { type: "array", items: annotationSchema, maxItems: PLAN_LIMITS.annotations }, lastError: safeErrorSchema,
  },
  required: ["schemaVersion", "id", "documentRevision", "stateVersion", "status", "source", "execution", "generation", "document", "annotations"], additionalProperties: false,
} as const;

function draftElementDefinition(revision: boolean) {
  return { type: "object", properties: { ...(revision ? { retainedId: idSchema } : {}), kind: { enum: PLAN_ELEMENT_KINDS }, title: stringSchema, body: stringSchema, children: { type: "array", items: { $ref: "#/$defs/element" }, maxItems: PLAN_LIMITS.children } }, required: ["kind", "body", "children"], additionalProperties: false } as const;
}
function makeDraftDocumentSchema(revision: boolean) {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", $defs: { element: draftElementDefinition(revision) }, type: "object", properties: { ...(revision ? { retainedId: idSchema } : {}), title: { $ref: "#/$defs/element" }, elements: { type: "array", items: { $ref: "#/$defs/element" }, maxItems: PLAN_LIMITS.children } }, required: ["title", "elements"], additionalProperties: false } as const;
}
const initialPlanDocumentDraftSchema = makeDraftDocumentSchema(false);
const revisionPlanDocumentDraftSchema = makeDraftDocumentSchema(true);
export const INITIAL_PLAN_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $defs: initialPlanDocumentDraftSchema.$defs, type: "object",
  properties: { kind: { const: "plan" }, document: { ...initialPlanDocumentDraftSchema, $schema: undefined, $defs: undefined } }, required: ["kind", "document"], additionalProperties: false,
} as const;
export const REVISION_PLAN_RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $defs: revisionPlanDocumentDraftSchema.$defs, type: "object",
  properties: { kind: { const: "revision" }, document: { ...revisionPlanDocumentDraftSchema, $schema: undefined, $defs: undefined }, addressedAnnotationIds: { type: "array", items: idSchema, maxItems: PLAN_LIMITS.annotations } },
  required: ["kind", "document", "addressedAnnotationIds"], additionalProperties: false,
} as const;
const sessionValidator = Compile(PLAN_SESSION_SCHEMA);
const planDocumentValidator = Compile(planDocumentSchema);
const annotationsValidator = Compile({ type: "array", items: annotationSchema, maxItems: PLAN_LIMITS.annotations } as const);
const initialValidator = Compile(INITIAL_PLAN_RESULT_SCHEMA);
const revisionValidator = Compile(REVISION_PLAN_RESULT_SCHEMA);
const clarificationQuestionsValidator = Compile(clarificationQuestionsSchema);
const grillResultValidator = Compile(GRILL_RESULT_SCHEMA);
const clarificationAnswersValidator = Compile({ type: "array", items: clarificationAnswerEntrySchema, minItems: 1, maxItems: PLAN_LIMITS.clarificationQuestions } as const);

/** Validates an already-parsed JSON value. Duplicate-key rejection belongs to the Milestone 4 raw JSON parser boundary. */
export function validatePlanDocument(input: unknown): ValidationResult<PlanDocument> {
  const structural = structuralCheck(planDocumentSchema, planDocumentValidator, input); if (structural) return failure(structural);
  const projection = isMarkdownPlanProjection(input);
  const value = normalizeDocument(input as PlanDocument, projection); const issues: ValidationIssue[] = []; validateDocumentSemantics(value, "$", issues);
  if (!projection && utf8Bytes(JSON.stringify(value)) > PLAN_LIMITS.planBytes) issues.push(issue("$", "plan-too-large", "Plan exceeds the UTF-8 byte limit."));
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validatePlanAnnotations(input: unknown, document: PlanDocument, revision: number): ValidationResult<readonly Annotation[]> {
  const structural = structuralCheck({ type: "array", items: annotationSchema, maxItems: PLAN_LIMITS.annotations }, annotationsValidator, input); if (structural) return failure(structural);
  const projectionIds = markdownProjectionElementIds(document);
  const value = (input as readonly Annotation[]).map((annotation) => normalizeAnnotation(annotation, projectionIds)); const issues: ValidationIssue[] = [];
  validateAnnotations(value, document, revision, issues);
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validatePlanSession(input: unknown): ValidationResult<PlanSession> {
  const sizeIssue = validateSessionJsonSize(input); if (sizeIssue) return failure(sizeIssue);
  const structural = structuralCheck(PLAN_SESSION_SCHEMA, sessionValidator, input); if (structural) return failure(structural);
  const normalized = normalizeSession(input as PlanSession);
  const issues: ValidationIssue[] = []; validateSessionSemantics(normalized, issues);
  return issues.length ? failure(issues) : success(deepFreeze(normalized));
}
export function validateInitialPlanResult(input: unknown): ValidationResult<InitialPlanResultDraft> {
  const sizeIssue = validateJsonSize(input); if (sizeIssue) return failure(sizeIssue);
  const structural = structuralCheck(INITIAL_PLAN_RESULT_SCHEMA, initialValidator, input); if (structural) return failure(structural);
  const value = normalizeInitialResult(input as InitialPlanResultDraft); const issues: ValidationIssue[] = []; validateDraftDocument(value.document, issues);
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validateRevisionPlanResult(input: unknown): ValidationResult<RevisionPlanResultDraft> {
  const sizeIssue = validateJsonSize(input); if (sizeIssue) return failure(sizeIssue);
  const structural = structuralCheck(REVISION_PLAN_RESULT_SCHEMA, revisionValidator, input); if (structural) return failure(structural);
  const value = normalizeRevisionResult(input as RevisionPlanResultDraft); const issues: ValidationIssue[] = []; validateDraftDocument(value.document, issues);
  uniqueStrings(value.addressedAnnotationIds, "$.addressedAnnotationIds", issues);
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validateGrillResult(input: unknown): ValidationResult<GrillResultDraft> {
  const sizeIssue = validateJsonSize(input); if (sizeIssue) return failure(sizeIssue);
  if (utf8Bytes(JSON.stringify(input)) > PLAN_LIMITS.grillResultBytes) return failure(issue("$", "grill-too-large", "Grill result exceeds 256 KiB."));
  const structural = structuralCheck(GRILL_RESULT_SCHEMA, grillResultValidator, input); if (structural) return failure(structural);
  const value = normalizeGrillResult(input as GrillResultDraft); const issues: ValidationIssue[] = [];
  for (const [key, annotation] of Object.entries(value.annotations)) { validateId(key, `$.annotations.${key}`, issues); validateText(annotation.body, `$.annotations.${key}.body`, PLAN_LIMITS.annotationBodyCodePoints, true, issues); }
  validateDecisionTree(value.decisionTree, "$.decisionTree", issues, new Set(Object.keys(value.annotations)));
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validateClarificationQuestions(input: unknown): ValidationResult<readonly ClarificationQuestion[]> {
  const structural = structuralCheck(clarificationQuestionsSchema, clarificationQuestionsValidator, input); if (structural) return failure(structural);
  const value = (input as readonly ClarificationQuestion[]).map(normalizeClarificationQuestion); const issues: ValidationIssue[] = [];
  validateQuestions(value, "$.questions", issues);
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
export function validateClarificationAnswers(
  input: unknown, questions: readonly ClarificationQuestion[],
): ValidationResult<readonly ClarificationAnswerEntry[]> {
  const structural = structuralCheck({ type: "array", items: clarificationAnswerEntrySchema, minItems: 1, maxItems: PLAN_LIMITS.clarificationQuestions }, clarificationAnswersValidator, input); if (structural) return failure(structural);
  const value = (input as readonly ClarificationAnswerEntry[]).map(normalizeClarificationAnswer); const issues: ValidationIssue[] = [];
  validateAnswers(value, questions, "$.answers", issues);
  return issues.length ? failure(issues) : success(deepFreeze(value));
}
function structuralCheck(schema: object, validator: { Check(value: unknown): boolean }, input: unknown): ValidationIssue[] | undefined {
  if (validator.Check(input) && Check(schema, input)) return undefined;
  const errors = Errors(schema as never, input).slice(0, 8).map((error) => issue(
    jsonPointerPath(error.instancePath),
    "invalid-structure",
    `${error.keyword}: ${error.message}`,
  ));
  return errors.length ? errors : [issue("$", "invalid-structure", "Value does not match the strict plan schema.")];
}
function jsonPointerPath(pointer: string): string {
  if (!pointer) return "$";
  return pointer.split("/").slice(1).reduce((path, raw) => {
    const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    return /^\d+$/u.test(part) ? `${path}[${part}]` : `${path}.${part}`;
  }, "$");
}
function validateJsonSize(input: unknown): ValidationIssue | undefined {
  try {
    const json = JSON.stringify(input);
    if (json === undefined) return issue("$", "invalid-structure", "Value is not JSON serializable.");
    return utf8Bytes(json) > PLAN_LIMITS.maxJsonBytes ? issue("$", "json-too-large", "JSON input exceeds the UTF-8 byte limit.") : undefined;
  } catch { return issue("$", "invalid-structure", "Value is not JSON serializable."); }
}
function validateSessionJsonSize(input: unknown): ValidationIssue | undefined {
  try {
    const json = JSON.stringify(sessionSizeValue(input));
    if (json === undefined) return issue("$", "invalid-structure", "Value is not JSON serializable.");
    return utf8Bytes(json) > PLAN_LIMITS.maxJsonBytes ? issue("$", "json-too-large", "JSON input exceeds the UTF-8 byte limit.") : undefined;
  } catch { return issue("$", "invalid-structure", "Value is not JSON serializable."); }
}
function normalizeSession(session: PlanSession): PlanSession {
  const projectionIds = markdownProjectionElementIds(session.document);
  const common = {
    schemaVersion: 1 as const, id: session.id, documentRevision: session.documentRevision, stateVersion: session.stateVersion, status: session.status,
    source: { prompt: normalizeCanonicalText(session.source.prompt), cwd: normalizeCanonicalText(session.source.cwd), skills: session.source.skills.map(normalizeSkill) },
    execution: { kind: session.execution.kind }, generation: { mode: session.generation.mode },
    document: session.document ? normalizeDocument(session.document, projectionIds.size > 0) : null, annotations: session.annotations.map((annotation) => normalizeAnnotation(annotation, projectionIds)),
    ...(session.generationJob ? { generationJob: normalizeGenerationOrigin(session.generationJob, { jobId: session.generationJob.jobId, startedAt: session.generationJob.startedAt }) } : {}),
    ...(session.committedMarkdown === undefined ? {} : { committedMarkdown: session.committedMarkdown }),
    ...(session.clarifications ? { clarifications: normalizeClarificationTranscript(session.clarifications) } : {}),
    ...(session.grill ? { grill: normalizeGrillArtifact(session.grill) } : {}),
    ...(session.lastError ? { lastError: { code: normalizeCanonicalText(session.lastError.code), message: normalizeCanonicalText(session.lastError.message) } } : {}),
  };
  return common as EmptyPlanSession | MaterializedPlanSession;
}
function normalizeSkill(skill: SkillReference): SkillReference { return { name: normalizeCanonicalText(skill.name), path: normalizeCanonicalText(skill.path), baseDir: normalizeCanonicalText(skill.baseDir), sha256: skill.sha256 }; }
function normalizeDocument(document: PlanDocument, opaque = false): PlanDocument { return { id: document.id, title: normalizeElement(document.title, opaque), elements: document.elements.map((element) => normalizeElement(element, opaque)) }; }
function normalizeElement(element: PlanElement, opaque: boolean): PlanElement { return { id: element.id, kind: element.kind, ...(element.title === undefined ? {} : { title: opaque ? element.title : normalizeCanonicalText(element.title) }), body: opaque ? element.body : normalizeCanonicalText(element.body), children: element.children.map((child) => normalizeElement(child, opaque)) }; }
function normalizeSelector(selector: TextSelector, opaque = false): TextSelector { return { field: selector.field, start: selector.start, end: selector.end, exact: opaque ? selector.exact : normalizeCanonicalText(selector.exact), ...(selector.prefix === undefined ? {} : { prefix: opaque ? selector.prefix : normalizeCanonicalText(selector.prefix) }), ...(selector.suffix === undefined ? {} : { suffix: opaque ? selector.suffix : normalizeCanonicalText(selector.suffix) }) }; }
function normalizeTarget(target: AnnotationTarget, opaque = false): AnnotationTarget { return target.kind === "range" ? { kind: "range", elementId: target.elementId, selector: normalizeSelector(target.selector, opaque) } : { kind: target.kind, elementId: target.elementId }; }
function normalizeSnapshot(snapshot: AnnotationTargetSnapshot, projectionIds: ReadonlySet<string>): AnnotationTargetSnapshot { const opaque = projectionIds.has(snapshot.target.elementId); return { documentRevision: snapshot.documentRevision, target: normalizeTarget(snapshot.target, opaque), elementKind: snapshot.elementKind, text: opaque ? snapshot.text : normalizeCanonicalText(snapshot.text) }; }
function normalizeHistory(entry: AnnotationHistoryEntry): AnnotationHistoryEntry { return { from: entry.from, to: entry.to, at: entry.at }; }
function normalizeAnnotation(annotation: Annotation, projectionIds: ReadonlySet<string> = new Set()): Annotation { return { id: annotation.id, ...(annotation.author === undefined ? {} : { author: annotation.author }), target: normalizeTarget(annotation.target, projectionIds.has(annotation.target.elementId)), targetSnapshot: normalizeSnapshot(annotation.targetSnapshot, projectionIds), body: normalizeCanonicalText(annotation.body), status: annotation.status, ...(annotation.statusBeforeOrphan ? { statusBeforeOrphan: annotation.statusBeforeOrphan } : {}), history: annotation.history.map(normalizeHistory), createdAgainstRevision: annotation.createdAgainstRevision, createdAt: annotation.createdAt, updatedAt: annotation.updatedAt }; }
function normalizeGenerationOrigin<T extends { readonly operation: PlanOperation; readonly baseDocumentRevision: number; readonly selectedAnnotationIds: readonly string[]; readonly instruction?: string }>(origin: T, extra: Record<string, string> = {}): T { return { ...extra, operation: origin.operation, baseDocumentRevision: origin.baseDocumentRevision, selectedAnnotationIds: [...origin.selectedAnnotationIds], ...(origin.instruction === undefined ? {} : { instruction: normalizeCanonicalText(origin.instruction) }) } as unknown as T; }
function normalizeClarificationQuestion(question: ClarificationQuestion): ClarificationQuestion { return { id: question.id, prompt: normalizeCanonicalText(question.prompt), options: question.options.map((option) => ({ id: option.id, label: normalizeCanonicalText(option.label) })) }; }
function normalizeClarificationAnswer(entry: ClarificationAnswerEntry): ClarificationAnswerEntry { return { questionId: entry.questionId, answer: entry.answer.kind === "option" ? { kind: "option", optionId: entry.answer.optionId } : { kind: "custom", text: normalizeCanonicalText(entry.answer.text) } }; }
function normalizeClarificationTranscript(value: ClarificationTranscript): ClarificationTranscript { return {
  history: value.history.map((round) => ({ id: round.id, questions: round.questions.map(normalizeClarificationQuestion), answers: round.answers.map(normalizeClarificationAnswer), answeredAt: round.answeredAt })),
  ...(value.origin ? { origin: normalizeGenerationOrigin(value.origin) } : {}),
  ...(value.pending ? { pending: { id: value.pending.id, questions: value.pending.questions.map(normalizeClarificationQuestion), ...normalizeGenerationOrigin({ operation: value.pending.operation, baseDocumentRevision: value.pending.baseDocumentRevision, selectedAnnotationIds: value.pending.selectedAnnotationIds, ...(value.pending.instruction === undefined ? {} : { instruction: value.pending.instruction }) }) } } : {}),
}; }
function inferDecisionTreeRoot(tree: GrillDecisionTreeDraft): string | undefined {
  if (tree.nodes.length === 0) return undefined;
  const nodeIds = new Set(tree.nodes.map((node) => node.id)); const parents = new Map(tree.nodes.map((node) => [node.id, 0]));
  for (const node of tree.nodes) for (const option of node.options) if (option.nextNodeId && nodeIds.has(option.nextNodeId)) parents.set(option.nextNodeId, (parents.get(option.nextNodeId) ?? 0) + 1);
  const roots = tree.nodes.filter((node) => parents.get(node.id) === 0);
  return roots.length === 1 ? roots[0]!.id : undefined;
}
function normalizeDecisionTree(tree: GrillDecisionTreeDraft): GrillDecisionTreeDraft { const rootNodeId = tree.rootNodeId ?? inferDecisionTreeRoot(tree); return { ...(rootNodeId === undefined ? {} : { rootNodeId }), nodes: tree.nodes.map((node) => ({ id: node.id, question: normalizeCanonicalText(node.question), annotationKeys: [...node.annotationKeys], options: node.options.map((option) => ({ id: option.id, label: normalizeCanonicalText(option.label), ...(option.nextNodeId === undefined ? {} : { nextNodeId: option.nextNodeId }), ...(option.decision === undefined ? {} : { decision: normalizeCanonicalText(option.decision) }) })) })) }; }
function normalizeGrillTarget(target: GrillAnnotationTargetDraft): GrillAnnotationTargetDraft {
  if (target.kind !== "range" || "selector" in target) return normalizeTarget(target, true);
  return { kind: "range", elementId: target.elementId, field: target.field, start: target.start, end: target.end };
}
function normalizeGrillResult(value: GrillResultDraft): GrillResultDraft { return { kind: "grill", basedOnDocumentRevision: value.basedOnDocumentRevision, annotations: Object.fromEntries(Object.entries(value.annotations).map(([key, annotation]) => [key, { target: normalizeGrillTarget(annotation.target), body: normalizeCanonicalText(annotation.body) }])), decisionTree: normalizeDecisionTree(value.decisionTree) }; }
function normalizeGrillArtifact(value: GrillArtifact): GrillArtifact { return { basedOnDocumentRevision: value.basedOnDocumentRevision, annotationIds: { ...value.annotationIds }, decisionTree: normalizeDecisionTree(value.decisionTree), generatedAt: value.generatedAt }; }
function normalizeInitialResult(value: InitialPlanResultDraft): InitialPlanResultDraft { return { kind: "plan", document: normalizeDraftDocument(value.document, false) as ModelPlanDocumentDraft }; }
function normalizeRevisionResult(value: RevisionPlanResultDraft): RevisionPlanResultDraft { return { kind: "revision", document: normalizeDraftDocument(value.document, true) as ModelRevisionPlanDocumentDraft, addressedAnnotationIds: [...value.addressedAnnotationIds] }; }
function normalizeDraftDocument(document: ModelPlanDocumentDraft | ModelRevisionPlanDocumentDraft, revision: boolean): ModelPlanDocumentDraft | ModelRevisionPlanDocumentDraft { return { ...(revision && "retainedId" in document && document.retainedId ? { retainedId: document.retainedId } : {}), title: normalizeDraftElement(document.title, revision), elements: document.elements.map((element) => normalizeDraftElement(element, revision)) } as ModelPlanDocumentDraft | ModelRevisionPlanDocumentDraft; }
function normalizeDraftElement(element: ModelPlanElementDraft | ModelRevisionPlanElementDraft, revision: boolean): ModelPlanElementDraft | ModelRevisionPlanElementDraft { return { ...(revision && "retainedId" in element && element.retainedId ? { retainedId: element.retainedId } : {}), kind: element.kind, ...(element.title === undefined ? {} : { title: normalizeCanonicalText(element.title) }), body: normalizeCanonicalText(element.body), children: element.children.map((child) => normalizeDraftElement(child, revision)) } as ModelPlanElementDraft | ModelRevisionPlanElementDraft; }

function validateSessionSemantics(session: PlanSession, issues: ValidationIssue[]): void {
  const projection = session.document !== null && isMarkdownPlanProjection(session.document);
  const linkedProjection = projection && session.committedMarkdown !== undefined && markdownProjectionText(session.document) === session.committedMarkdown;
  validateId(session.id, "$.id", issues); validateSafeInteger(session.stateVersion, "$.stateVersion", issues); validateSafeInteger(session.documentRevision, "$.documentRevision", issues);
  validateText(session.source.prompt, "$.source.prompt", PLAN_LIMITS.sourcePromptCodePoints, true, issues); validateText(session.source.cwd, "$.source.cwd", PLAN_LIMITS.pathCodePoints, true, issues);
  const names: string[] = [], paths: string[] = [];
  session.source.skills.forEach((skill, index) => { const path = `$.source.skills[${index}]`; names.push(skill.name); paths.push(skill.path); validateText(skill.name, `${path}.name`, PLAN_LIMITS.skillNameCodePoints, true, issues); validateText(skill.path, `${path}.path`, PLAN_LIMITS.pathCodePoints, true, issues); validateText(skill.baseDir, `${path}.baseDir`, PLAN_LIMITS.baseDirCodePoints, true, issues); if (!/^[a-f0-9]{64}$/.test(skill.sha256)) issues.push(issue(`${path}.sha256`, "invalid-digest", "Skill digest must be lowercase SHA-256.")); });
  uniqueStrings(names, "$.source.skills.name", issues); uniqueStrings(paths, "$.source.skills.path", issues);
  if (session.lastError) { validateText(session.lastError.code, "$.lastError.code", PLAN_LIMITS.safeErrorCodeCodePoints, true, issues); if (!/^[a-z0-9][a-z0-9._-]*$/.test(session.lastError.code)) issues.push(issue("$.lastError.code", "invalid-error-code", "Safe error code must use lowercase ASCII tokens.")); validateText(session.lastError.message, "$.lastError.message", PLAN_LIMITS.safeErrorMessageCodePoints, true, issues); }
  if (session.generationJob) {
    const job = session.generationJob; validateId(job.jobId, "$.generationJob.jobId", issues); validateSafeInteger(job.baseDocumentRevision, "$.generationJob.baseDocumentRevision", issues);
    validateTimestamp(job.startedAt, "$.generationJob.startedAt", issues); uniqueStrings(job.selectedAnnotationIds, "$.generationJob.selectedAnnotationIds", issues);
    if (job.instruction !== undefined) {
      validateText(job.instruction, "$.generationJob.instruction", PLAN_LIMITS.generationInstructionBytes, false, issues);
      if (utf8Bytes(job.instruction) > PLAN_LIMITS.generationInstructionBytes) issues.push(issue("$.generationJob.instruction", "too-long", "Generation instruction exceeds 16 KiB."));
    }
    if (!(["generating", "revising", "grilling"] as const).includes(session.status as "generating" | "revising" | "grilling")) issues.push(issue("$.generationJob", "job-status", "A generation job requires generating, revising, or grilling status."));
    if (job.operation === "initial" && (job.baseDocumentRevision !== 0 || session.status !== "generating" || job.selectedAnnotationIds.length !== 0)) issues.push(issue("$.generationJob", "job-operation", "An initial job must start from empty revision zero."));
    if (job.operation === "revision" && (job.baseDocumentRevision < 1 || session.status !== "revising")) issues.push(issue("$.generationJob", "job-operation", "A revision job requires a materialized base revision."));
    if (job.operation === "grill" && (job.baseDocumentRevision < 1 || session.status !== "grilling" || job.selectedAnnotationIds.length !== 0)) issues.push(issue("$.generationJob", "job-operation", "A grill job requires a materialized base revision without selected annotations."));
    if (job.baseDocumentRevision !== session.documentRevision) issues.push(issue("$.generationJob.baseDocumentRevision", "job-revision", "The generation job must match the current document revision."));
    const annotationIds = new Set(session.annotations.map((annotation) => annotation.id));
    if (job.selectedAnnotationIds.some((id) => !annotationIds.has(id))) issues.push(issue("$.generationJob.selectedAnnotationIds", "unknown-annotation", "Generation jobs may select only current annotations."));
  } else if (session.status === "generating" || session.status === "revising" || session.status === "grilling") issues.push(issue("$.generationJob", "missing-job", "Generating, revising, and grilling status require a generation job."));
  validateClarificationTranscript(session.clarifications, session, issues);
  if (session.status === "awaiting-clarification" && !session.clarifications?.pending) issues.push(issue("$.clarifications.pending", "missing-clarification", "Awaiting clarification requires one pending round."));
  if (session.clarifications?.pending && session.status === "ready") issues.push(issue("$.status", "clarification-status", "A pending clarification cannot be ready for review."));
  if (session.status === "needs-input" && session.lastError?.code !== "skill-context-changed") issues.push(issue("$.lastError", "missing-error", "Needs-input requires a skill-context-changed error."));
  if (session.document === null) {
    if (session.documentRevision !== 0) issues.push(issue("$.documentRevision", "empty-revision", "A session without a document must have revision 0."));
    if (session.annotations.length !== 0) issues.push(issue("$.annotations", "empty-annotations", "A session without a document cannot have annotations."));
    if (["ready", "revising", "grilling", "accepted"].includes(session.status)) issues.push(issue("$.status", "invalid-empty-status", "This status requires a materialized plan."));
  } else {
    if (session.documentRevision < 1) issues.push(issue("$.documentRevision", "materialized-revision", "A materialized plan must have revision 1 or greater."));
    if (projection && !isMarkdownPlanProjection(session.document, session.documentRevision)) issues.push(issue("$.document.id", "projection-revision", "Markdown projection identity must match the document revision."));
    if (projection && !linkedProjection) issues.push(issue("$.committedMarkdown", "projection-markdown", "Markdown projection text must exactly match authoritative committed Markdown."));
    validateDocumentSemantics(session.document, "$.document", issues); validateAnnotations(session.annotations, session.document, session.documentRevision, issues);
    if (session.grill) {
      if (session.grill.basedOnDocumentRevision !== session.documentRevision) issues.push(issue("$.grill.basedOnDocumentRevision", "grill-revision", "Grill artifact must match the current document revision."));
      validateTimestamp(session.grill.generatedAt, "$.grill.generatedAt", issues);
      const generated = new Set(session.annotations.filter((annotation) => annotation.author === "grill").map((annotation) => annotation.id)); const mapped = Object.values(session.grill.annotationIds);
      uniqueStrings(mapped, "$.grill.annotationIds", issues); if (mapped.length !== generated.size || mapped.some((id) => !generated.has(id))) issues.push(issue("$.grill.annotationIds", "grill-annotations", "Grill artifact must reference exactly the generated annotations."));
      validateDecisionTree(session.grill.decisionTree, "$.grill.decisionTree", issues, new Set(Object.keys(session.grill.annotationIds)));
    } else if (session.annotations.some((annotation) => annotation.author === "grill")) issues.push(issue("$.annotations", "missing-grill", "Generated annotations require a Grill artifact."));
    if (!projection && utf8Bytes(JSON.stringify(session.document)) > PLAN_LIMITS.planBytes) issues.push(issue("$.document", "plan-too-large", "Plan exceeds the UTF-8 byte limit."));
  }
  if (session.committedMarkdown !== undefined) {
    if (linkedProjection) validateOpaqueText(session.committedMarkdown, "$.committedMarkdown", PLAN_LIMITS.committedMarkdownBytes, issues);
    else validateText(session.committedMarkdown, "$.committedMarkdown", PLAN_LIMITS.committedMarkdownBytes, true, issues);
    if (utf8Bytes(session.committedMarkdown) > PLAN_LIMITS.committedMarkdownBytes) issues.push(issue("$.committedMarkdown", "too-long", "Committed Markdown exceeds the byte limit."));
    if (!session.document) issues.push(issue("$.committedMarkdown", "markdown-without-document", "Committed Markdown requires a materialized document."));
  }
  if (utf8Bytes(JSON.stringify(sessionSizeValue(session))) > PLAN_LIMITS.sessionBytes) issues.push(issue("$", "session-too-large", "Session exceeds the UTF-8 byte limit."));
}
function validateClarificationTranscript(value: ClarificationTranscript | undefined, session: PlanSession, issues: ValidationIssue[]): void {
  if (!value) return;
  if (value.history.length + (value.pending ? 1 : 0) > PLAN_LIMITS.clarificationRounds) issues.push(issue("$.clarifications", "too-many-rounds", "Clarification transcript exceeds 16 rounds."));
  const roundIds: string[] = [];
  value.history.forEach((round, index) => {
    const path = `$.clarifications.history[${index}]`; roundIds.push(round.id); validateId(round.id, `${path}.id`, issues); validateTimestamp(round.answeredAt, `${path}.answeredAt`, issues);
    validateQuestions(round.questions, `${path}.questions`, issues); validateAnswers(round.answers, round.questions, `${path}.answers`, issues);
  });
  if (value.origin) validateOrigin(value.origin, "$.clarifications.origin", session, issues);
  if (value.pending) {
    const path = "$.clarifications.pending"; roundIds.push(value.pending.id); validateId(value.pending.id, `${path}.id`, issues);
    validateQuestions(value.pending.questions, `${path}.questions`, issues); validateOrigin(value.pending, path, session, issues);
    if (!value.origin || !sameOrigin(value.origin, value.pending)) issues.push(issue(path, "origin-mismatch", "Pending clarification origin must match its resumable origin."));
  }
  uniqueStrings(roundIds, "$.clarifications.id", issues);
  if (!value.origin && value.pending) issues.push(issue("$.clarifications.origin", "missing-origin", "Pending clarification requires a resumable origin."));
  if (value.origin && session.generationJob && !sameOrigin(value.origin, session.generationJob)) issues.push(issue("$.generationJob", "origin-mismatch", "Continuation job must preserve the clarification origin."));
}
function validateOrigin(origin: ClarificationOrigin, path: string, session: PlanSession, issues: ValidationIssue[]): void {
  validateSafeInteger(origin.baseDocumentRevision, `${path}.baseDocumentRevision`, issues); uniqueStrings(origin.selectedAnnotationIds, `${path}.selectedAnnotationIds`, issues);
  if (origin.instruction !== undefined) { validateText(origin.instruction, `${path}.instruction`, PLAN_LIMITS.generationInstructionBytes, false, issues); if (utf8Bytes(origin.instruction) > PLAN_LIMITS.generationInstructionBytes) issues.push(issue(`${path}.instruction`, "too-long", "Clarification instruction exceeds 16 KiB.")); }
  if (origin.operation === "initial" && (origin.baseDocumentRevision !== 0 || origin.selectedAnnotationIds.length !== 0)) issues.push(issue(path, "origin-operation", "Initial clarification must originate at revision zero without selected notes."));
  if (origin.operation === "revision" && origin.baseDocumentRevision < 1) issues.push(issue(path, "origin-operation", "Revision clarification requires a materialized base revision."));
  if (origin.baseDocumentRevision !== session.documentRevision) issues.push(issue(`${path}.baseDocumentRevision`, "origin-revision", "Clarification origin must match the current document revision."));
  const ids = new Set(session.annotations.map((annotation) => annotation.id)); if (origin.selectedAnnotationIds.some((id) => !ids.has(id))) issues.push(issue(`${path}.selectedAnnotationIds`, "unknown-annotation", "Clarification origin may select only current annotations."));
}
function validateDecisionTree(tree: GrillDecisionTreeDraft, path: string, issues: ValidationIssue[], annotationKeys: ReadonlySet<string>): void {
  if (tree.nodes.length === 0) { if (tree.rootNodeId !== undefined) issues.push(issue(`${path}.rootNodeId`, "empty-tree-root", "An empty decision tree must not declare a root.")); if (annotationKeys.size !== 0) issues.push(issue(`${path}.nodes.annotationKeys`, "annotation-coverage", "Every generated annotation key must be referenced exactly once.")); return; }
  const nodes = new Map(tree.nodes.map((node) => [node.id, node])); uniqueStrings(tree.nodes.map((node) => node.id), `${path}.nodes.id`, issues);
  if (tree.rootNodeId !== undefined) { validateId(tree.rootNodeId, `${path}.rootNodeId`, issues); if (!nodes.has(tree.rootNodeId)) issues.push(issue(`${path}.rootNodeId`, "unknown-node", "Decision tree root must exist.")); }
  const referenced: string[] = [];
  tree.nodes.forEach((node, index) => { const nodePath = `${path}.nodes[${index}]`; validateId(node.id, `${nodePath}.id`, issues); validateText(node.question, `${nodePath}.question`, PLAN_LIMITS.grillDecisionCodePoints, true, issues); uniqueStrings(node.annotationKeys, `${nodePath}.annotationKeys`, issues); node.annotationKeys.forEach((key, keyIndex) => { referenced.push(key); validateId(key, `${nodePath}.annotationKeys[${keyIndex}]`, issues); if (!annotationKeys.has(key)) issues.push(issue(`${nodePath}.annotationKeys[${keyIndex}]`, "unknown-annotation-key", "Decision node annotation key must exist.")); }); uniqueStrings(node.options.map((option) => option.id), `${nodePath}.options.id`, issues); node.options.forEach((option, optionIndex) => { const optionPath = `${nodePath}.options[${optionIndex}]`; validateId(option.id, `${optionPath}.id`, issues); validateText(option.label, `${optionPath}.label`, PLAN_LIMITS.clarificationLabelCodePoints, true, issues); const branches = Number(option.nextNodeId !== undefined) + Number(option.decision !== undefined); if (branches !== 1) issues.push(issue(optionPath, "invalid-branch", "Each option requires exactly one next node or final decision.")); if (option.nextNodeId !== undefined && !nodes.has(option.nextNodeId)) issues.push(issue(`${optionPath}.nextNodeId`, "unknown-node", "Decision tree branch target must exist.")); if (option.decision !== undefined) validateText(option.decision, `${optionPath}.decision`, PLAN_LIMITS.grillDecisionCodePoints, true, issues); }); });
  uniqueStrings(referenced, `${path}.nodes.annotationKeys`, issues); if (referenced.length !== annotationKeys.size || referenced.some((key) => !annotationKeys.has(key))) issues.push(issue(`${path}.nodes.annotationKeys`, "annotation-coverage", "Every generated annotation key must be referenced exactly once."));
  const parents = new Map(tree.nodes.map((node) => [node.id, 0])); for (const node of tree.nodes) for (const option of node.options) if (option.nextNodeId && nodes.has(option.nextNodeId)) parents.set(option.nextNodeId, (parents.get(option.nextNodeId) ?? 0) + 1);
  const roots = tree.nodes.filter((node) => parents.get(node.id) === 0);
  if (tree.rootNodeId === undefined) issues.push(issue(`${path}.rootNodeId`, roots.length > 1 ? "ambiguous-root" : "no-root", roots.length > 1 ? "Decision tree has multiple zero-indegree roots." : "Decision tree has no zero-indegree root."));
  else if ((parents.get(tree.rootNodeId) ?? 0) !== 0 || tree.nodes.some((node) => node.id !== tree.rootNodeId && parents.get(node.id) !== 1)) issues.push(issue(`${path}.nodes`, "invalid-tree", "Every non-root decision node must have exactly one parent."));
  const visited = new Set<string>(), active = new Set<string>(); let cycle = false;
  const visit = (id: string): void => { if (active.has(id)) { cycle = true; return; } if (visited.has(id)) return; visited.add(id); active.add(id); for (const option of nodes.get(id)?.options ?? []) if (option.nextNodeId && nodes.has(option.nextNodeId)) visit(option.nextNodeId); active.delete(id); };
  for (const node of tree.nodes) visit(node.id); if (cycle) issues.push(issue(path, "decision-cycle", "Decision tree must be acyclic."));
  if (tree.rootNodeId !== undefined && nodes.has(tree.rootNodeId)) { const reachable = new Set<string>(); const reach = (id: string): void => { if (reachable.has(id)) return; reachable.add(id); for (const option of nodes.get(id)?.options ?? []) if (option.nextNodeId && nodes.has(option.nextNodeId)) reach(option.nextNodeId); }; reach(tree.rootNodeId); if (reachable.size !== nodes.size) issues.push(issue(`${path}.nodes`, "unreachable-node", "Every decision node must be reachable from the root.")); }
}
function validateQuestions(questions: readonly ClarificationQuestion[], path: string, issues: ValidationIssue[]): void {
  const localQuestions: string[] = [];
  questions.forEach((question, index) => { const questionPath = `${path}[${index}]`; validateId(question.id, `${questionPath}.id`, issues); validateText(question.prompt, `${questionPath}.prompt`, PLAN_LIMITS.clarificationPromptCodePoints, true, issues); localQuestions.push(question.id);
    const localOptions: string[] = []; question.options.forEach((option, optionIndex) => { const optionPath = `${questionPath}.options[${optionIndex}]`; validateId(option.id, `${optionPath}.id`, issues); validateText(option.label, `${optionPath}.label`, PLAN_LIMITS.clarificationLabelCodePoints, true, issues); localOptions.push(option.id); }); uniqueStrings(localOptions, `${questionPath}.options.id`, issues); });
  uniqueStrings(localQuestions, `${path}.id`, issues);
}
function validateAnswers(answers: readonly ClarificationAnswerEntry[], questions: readonly ClarificationQuestion[], path: string, issues: ValidationIssue[]): void {
  const questionMap = new Map(questions.map((question) => [question.id, question])); uniqueStrings(answers.map((entry) => entry.questionId), `${path}.questionId`, issues);
  if (answers.length !== questions.length || answers.some((entry) => !questionMap.has(entry.questionId))) issues.push(issue(path, "incomplete-answers", "Every clarification question requires exactly one answer."));
  answers.forEach((entry, index) => { const answerPath = `${path}[${index}].answer`; validateId(entry.questionId, `${path}[${index}].questionId`, issues); const question = questionMap.get(entry.questionId); const answer = entry.answer; if (answer.kind === "custom") validateText(answer.text, `${answerPath}.text`, PLAN_LIMITS.clarificationAnswerCodePoints, true, issues); else if (!question?.options.some((option) => option.id === answer.optionId)) issues.push(issue(`${answerPath}.optionId`, "unknown-option", "The selected clarification option does not exist.")); });
}
function sameOrigin(left: ClarificationOrigin, right: { readonly operation: PlanOperation; readonly baseDocumentRevision: number; readonly selectedAnnotationIds: readonly string[]; readonly instruction?: string }): boolean { return left.operation === right.operation && left.baseDocumentRevision === right.baseDocumentRevision && left.instruction === right.instruction && left.selectedAnnotationIds.length === right.selectedAnnotationIds.length && left.selectedAnnotationIds.every((id, index) => id === right.selectedAnnotationIds[index]); }
function validateDocumentSemantics(document: PlanDocument, rootPath: string, issues: ValidationIssue[]): void {
  const projection = isMarkdownPlanProjection(document);
  validateId(document.id, `${rootPath}.id`, issues); const ids = new Set<string>([document.id]); let count = 0, executions = 0;
  const walk = (element: PlanElement, depth: number, path: string, topLevel: boolean): void => {
    count += 1; validateId(element.id, `${path}.id`, issues); if (ids.has(element.id)) issues.push(issue(`${path}.id`, "duplicate-id", "Plan element IDs must be unique.")); else ids.add(element.id);
    if (projection) validateOpaqueText(element.body, `${path}.body`, element.kind === "title" ? PLAN_LIMITS.titleCodePoints : PLAN_LIMITS.bodyCodePoints, issues);
    else validateText(element.body, `${path}.body`, element.kind === "title" ? PLAN_LIMITS.titleCodePoints : PLAN_LIMITS.bodyCodePoints, true, issues);
    if (element.title !== undefined) {
      if (projection) validateOpaqueText(element.title, `${path}.title`, PLAN_LIMITS.titleCodePoints, issues);
      else validateText(element.title, `${path}.title`, PLAN_LIMITS.titleCodePoints, true, issues);
    }
    if (depth > PLAN_LIMITS.depth) issues.push(issue(path, "too-deep", "Plan nesting exceeds the depth limit."));
    if (element.kind === "execution") { executions += 1; if (!topLevel) issues.push(issue(`${path}.kind`, "nested-execution", "Execution must be top-level.")); }
    if (element.kind === "title" && path !== `${rootPath}.title`) issues.push(issue(`${path}.kind`, "duplicate-title", "Title elements cannot be nested or repeated."));
    element.children.forEach((child, index) => walk(child, depth + 1, `${path}.children[${index}]`, false));
  };
  if (document.title.kind !== "title") issues.push(issue(`${rootPath}.title.kind`, "invalid-title", "The document title node must have kind title."));
  walk(document.title, 1, `${rootPath}.title`, true); document.elements.forEach((element, index) => walk(element, 1, `${rootPath}.elements[${index}]`, true));
  if (count > PLAN_LIMITS.elements) issues.push(issue(rootPath, "too-many-elements", "Plan has too many elements.")); if (executions !== 1) issues.push(issue(`${rootPath}.elements`, "execution-count", "Plan must contain exactly one top-level execution element."));
  if (projection && utf8Bytes(markdownProjectionText(document)) > PLAN_LIMITS.committedMarkdownBytes) issues.push(issue(rootPath, "plan-too-large", "Markdown projection exceeds the committed Markdown byte limit."));
}
function validateDraftDocument(document: ModelPlanDocumentDraft | ModelRevisionPlanDocumentDraft, issues: ValidationIssue[]): void {
  let count = 0, executions = 0;
  const walk = (element: ModelPlanElementDraft | ModelRevisionPlanElementDraft, depth: number, path: string, topLevel: boolean): void => { count += 1; validateText(element.body, `${path}.body`, element.kind === "title" ? PLAN_LIMITS.titleCodePoints : PLAN_LIMITS.bodyCodePoints, true, issues); if (element.title !== undefined) validateText(element.title, `${path}.title`, PLAN_LIMITS.titleCodePoints, true, issues); if ("retainedId" in element && element.retainedId !== undefined) validateId(element.retainedId, `${path}.retainedId`, issues); if (depth > PLAN_LIMITS.depth) issues.push(issue(path, "too-deep", "Plan nesting exceeds the depth limit.")); if (element.kind === "execution") { executions += 1; if (!topLevel) issues.push(issue(`${path}.kind`, "nested-execution", "Execution must be top-level.")); } if (element.kind === "title" && path !== "$.document.title") issues.push(issue(`${path}.kind`, "duplicate-title", "Title elements cannot be nested or repeated.")); element.children.forEach((child, index) => walk(child, depth + 1, `${path}.children[${index}]`, false)); };
  if ("retainedId" in document && document.retainedId !== undefined) validateId(document.retainedId, "$.document.retainedId", issues);
  if (document.title.kind !== "title") issues.push(issue("$.document.title.kind", "invalid-title", "The document title node must have kind title.")); walk(document.title, 1, "$.document.title", true); document.elements.forEach((element, index) => walk(element, 1, `$.document.elements[${index}]`, true));
  if (count > PLAN_LIMITS.elements) issues.push(issue("$.document", "too-many-elements", "Plan has too many elements.")); if (executions !== 1) issues.push(issue("$.document.elements", "execution-count", "Plan must contain exactly one top-level execution element.")); if (utf8Bytes(JSON.stringify(document)) > PLAN_LIMITS.planBytes) issues.push(issue("$.document", "plan-too-large", "Plan exceeds the UTF-8 byte limit."));
}
/** Recognizes only the controller's versioned, opaque Markdown compatibility projection. */
export function isMarkdownPlanProjection(input: unknown, expectedRevision?: number): input is PlanDocument {
  if (!plainRecord(input) || !exactKeys(input, ["id", "title", "elements"]) || typeof input.id !== "string") return false;
  const match = /^markdown-projection-v1-(0|[1-9]\d*)$/u.exec(input.id); if (!match) return false;
  const revision = Number(match[1]); if (!Number.isSafeInteger(revision) || revision < 1 || expectedRevision !== undefined && revision !== expectedRevision) return false;
  const suffix = String(revision); const title = input.title;
  if (!plainRecord(title) || !exactKeys(title, ["id", "kind", "body", "children"]) || title.id !== `markdown-projection-title-v1-${suffix}` || title.kind !== "title" || title.body !== "" || !Array.isArray(title.children) || title.children.length !== 0) return false;
  if (!Array.isArray(input.elements) || input.elements.length !== 1) return false;
  const execution = input.elements[0];
  if (!plainRecord(execution) || !exactKeys(execution, ["id", "kind", "body", "children"]) || execution.id !== `markdown-projection-chunk-v1-${suffix}-0` || execution.kind !== "execution" || typeof execution.body !== "string" || !Array.isArray(execution.children)) return false;
  const bodies = [execution.body];
  for (let index = 0; index < execution.children.length; index += 1) {
    const child = execution.children[index];
    if (!plainRecord(child) || !exactKeys(child, ["id", "kind", "body", "children"]) || child.id !== `markdown-projection-chunk-v1-${suffix}-${index + 1}` || child.kind !== "step" || typeof child.body !== "string" || !Array.isArray(child.children) || child.children.length !== 0) return false;
    bodies.push(child.body);
  }
  const expected = chunkProjectionText(bodies.join(""));
  return expected.length === bodies.length && expected.every((body, index) => body === bodies[index]);
}
function markdownProjectionText(document: PlanDocument): string { const execution = document.elements[0]; return execution ? [execution.body, ...execution.children.map((child) => child.body)].join("") : ""; }
function markdownProjectionElementIds(document: PlanDocument | null): ReadonlySet<string> {
  if (!isMarkdownPlanProjection(document)) return new Set();
  const execution = document.elements[0]!; return new Set([document.title.id, execution.id, ...execution.children.map((child) => child.id)]);
}
function chunkProjectionText(value: string): string[] {
  const points = [...value]; if (points.length === 0) return [""]; const chunks: string[] = [];
  for (let index = 0; index < points.length; index += PLAN_LIMITS.bodyCodePoints) chunks.push(points.slice(index, index + PLAN_LIMITS.bodyCodePoints).join(""));
  return chunks;
}
function sessionSizeValue(input: unknown): unknown {
  if (!plainRecord(input) || typeof input.committedMarkdown !== "string" || typeof input.documentRevision !== "number"
    || !isMarkdownPlanProjection(input.document, input.documentRevision) || markdownProjectionText(input.document) !== input.committedMarkdown) return input;
  return { ...input, document: null, committedMarkdown: "" };
}
function plainRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === expected.length && keys.every((key) => expected.includes(key)); }

function collectElements(document: PlanDocument): ReadonlyMap<string, PlanElement> { const elements = new Map<string, PlanElement>(); const collect = (element: PlanElement): void => { elements.set(element.id, element); element.children.forEach(collect); }; collect(document.title); document.elements.forEach(collect); return elements; }
function validateAnnotations(annotations: readonly Annotation[], document: PlanDocument, revision: number, issues: ValidationIssue[]): void { uniqueStrings(annotations.map((entry) => entry.id), "$.annotations.id", issues); const elements = collectElements(document); annotations.forEach((annotation, index) => validateAnnotationSemantics(annotation, document, elements, revision, `$.annotations[${index}]`, issues)); }
function validateAnnotationSemantics(annotation: Annotation, document: PlanDocument, elements: ReadonlyMap<string, PlanElement>, revision: number, path: string, issues: ValidationIssue[]): void {
  validateId(annotation.id, `${path}.id`, issues); validateText(annotation.body, `${path}.body`, PLAN_LIMITS.annotationBodyCodePoints, true, issues); validateTimestamp(annotation.createdAt, `${path}.createdAt`, issues); validateTimestamp(annotation.updatedAt, `${path}.updatedAt`, issues); if (annotation.updatedAt < annotation.createdAt) issues.push(issue(`${path}.updatedAt`, "timestamp-order", "updatedAt cannot precede createdAt."));
  if (!Number.isSafeInteger(annotation.createdAgainstRevision) || annotation.createdAgainstRevision < 1 || annotation.createdAgainstRevision > revision) issues.push(issue(`${path}.createdAgainstRevision`, "invalid-revision", "Annotation revision is invalid."));
  if (annotation.targetSnapshot.documentRevision !== annotation.createdAgainstRevision) issues.push(issue(`${path}.targetSnapshot.documentRevision`, "snapshot-revision", "Snapshot revision must equal the annotation creation revision."));
  annotation.history.forEach((entry, index) => { const entryPath = `${path}.history[${index}]`; validateTimestamp(entry.at, `${entryPath}.at`, issues); if (entry.at < annotation.createdAt || entry.at > annotation.updatedAt) issues.push(issue(`${entryPath}.at`, "invalid-history", "History timestamps must fall within the annotation lifetime.")); if (entry.from === entry.to) issues.push(issue(entryPath, "invalid-transition", "A status transition must change status.")); const previous = annotation.history[index - 1]; if (previous && (previous.to !== entry.from || previous.at > entry.at)) issues.push(issue(entryPath, "invalid-history", "Annotation transitions must be continuous and chronological.")); });
  const first = annotation.history[0]; if (first && first.from !== "open") issues.push(issue(`${path}.history`, "invalid-history", "Annotation history must begin from open."));
  const last = annotation.history.at(-1); if (!last && annotation.status !== "open") issues.push(issue(`${path}.history`, "invalid-history", "Only a newly-open annotation may have empty history.")); else if (last && last.to !== annotation.status) issues.push(issue(`${path}.history`, "invalid-history", "The final transition must match the current status."));
  const orphaned = annotation.status === "orphaned"; if (orphaned !== (annotation.statusBeforeOrphan !== undefined)) issues.push(issue(`${path}.statusBeforeOrphan`, "orphan-status", "statusBeforeOrphan exists if and only if status is orphaned.")); if (orphaned && last && (last.from !== annotation.statusBeforeOrphan || last.to !== "orphaned")) issues.push(issue(`${path}.statusBeforeOrphan`, "orphan-status", "Prior orphan status must match the orphan transition."));
  validateSnapshot(annotation, document, elements, revision, path, issues); validateTarget(annotation, document, elements, revision, path, issues);
}
function validateSnapshot(annotation: Annotation, document: PlanDocument, elements: ReadonlyMap<string, PlanElement>, revision: number, path: string, issues: ValidationIssue[]): void {
  const snapshot = annotation.targetSnapshot; const snapshotPath = `${path}.targetSnapshot`; const projectionText = isMarkdownPlanProjection(document) && elements.has(snapshot.target.elementId);
  if (projectionText) validateOpaqueText(snapshot.text, `${snapshotPath}.text`, PLAN_LIMITS.bodyCodePoints + PLAN_LIMITS.titleCodePoints + 1, issues);
  else validateText(snapshot.text, `${snapshotPath}.text`, PLAN_LIMITS.bodyCodePoints + PLAN_LIMITS.titleCodePoints + 1, snapshot.target.kind !== "root", issues);
  if (!sameTargetIdentity(annotation.target, snapshot.target)) issues.push(issue(`${snapshotPath}.target`, "snapshot-target", "Snapshot target identity must match the annotation target."));
  if (snapshot.target.kind === "root") {
    validateId(snapshot.target.elementId, `${snapshotPath}.target.elementId`, issues); if (snapshot.elementKind !== "root") issues.push(issue(`${snapshotPath}.elementKind`, "snapshot-kind", "Root snapshots must use root kind.")); if (snapshot.text !== "") issues.push(issue(`${snapshotPath}.text`, "snapshot-text", "Root snapshot text must be empty.")); if (snapshot.target.elementId !== document.id) issues.push(issue(`${snapshotPath}.target.elementId`, "snapshot-fidelity", "Root snapshot must identify the current document.")); return;
  }
  validateId(snapshot.target.elementId, `${snapshotPath}.target.elementId`, issues); if (snapshot.elementKind === "root") issues.push(issue(`${snapshotPath}.elementKind`, "snapshot-kind", "Element snapshots must use a plan element kind."));
  if (snapshot.target.kind === "range") { validateSelectorIntrinsic(snapshot.target.selector, `${snapshotPath}.target.selector`, issues, projectionText); validateSelectorQuote(snapshot.target.selector, snapshot.text, `${snapshotPath}.target.selector`, issues); }
  if (snapshot.documentRevision !== revision) return;
  const element = elements.get(snapshot.target.elementId); if (!element) { issues.push(issue(`${snapshotPath}.target.elementId`, "snapshot-fidelity", "Current snapshot element must exist.")); return; }
  if (snapshot.elementKind !== element.kind) issues.push(issue(`${snapshotPath}.elementKind`, "snapshot-fidelity", "Current snapshot kind must match the element."));
  const expected = snapshot.target.kind === "range" ? fieldText(element, snapshot.target.selector.field) : canonicalElementText(element);
  if (expected === undefined || snapshot.text !== expected) issues.push(issue(`${snapshotPath}.text`, "snapshot-fidelity", "Current snapshot text must match canonical element text."));
}
function validateTarget(annotation: Annotation, document: PlanDocument, elements: ReadonlyMap<string, PlanElement>, revision: number, path: string, issues: ValidationIssue[]): void {
  const target = annotation.target; const targetPath = `${path}.target`; const orphaned = annotation.status === "orphaned";
  if (target.kind === "root") { validateId(target.elementId, `${targetPath}.elementId`, issues); if (target.elementId !== document.id) issues.push(issue(`${targetPath}.elementId`, "unknown-target", "Root annotation must identify the current document.")); return; }
  validateId(target.elementId, `${targetPath}.elementId`, issues); const element = elements.get(target.elementId);
  if (!element && !orphaned) { issues.push(issue(`${targetPath}.elementId`, "unknown-target", "Annotation target does not exist.")); return; }
  if (target.kind !== "range") return;
  validateSelectorIntrinsic(target.selector, `${targetPath}.selector`, issues, isMarkdownPlanProjection(document) && element !== undefined);
  if (orphaned) validateSelectorQuote(target.selector, annotation.targetSnapshot.text, `${targetPath}.selector`, issues);
  else if (element) { const text = fieldText(element, target.selector.field); if (text === undefined) issues.push(issue(`${targetPath}.selector.field`, "missing-field", "Selected field does not exist.")); else validateSelectorQuote(target.selector, text, `${targetPath}.selector`, issues); }
}
function sameTargetIdentity(target: AnnotationTarget, snapshot: AnnotationTarget): boolean { if (target.kind !== snapshot.kind || target.elementId !== snapshot.elementId) return false; if (target.kind !== "range" || snapshot.kind !== "range") return true; return target.selector.field === snapshot.selector.field && target.selector.exact === snapshot.selector.exact; }
function canonicalElementText(element: PlanElement): string { return `${element.title === undefined ? "" : `${element.title}\n`}${element.body}`; }
function fieldText(element: PlanElement, field: TextSelector["field"]): string | undefined { return field === "title" ? element.title : element.body; }
function validateSelectorIntrinsic(selector: TextSelector, path: string, issues: ValidationIssue[], opaque = false): void {
  if (opaque) validateOpaqueText(selector.exact, `${path}.exact`, PLAN_LIMITS.selectorExactCodePoints, issues);
  else validateText(selector.exact, `${path}.exact`, PLAN_LIMITS.selectorExactCodePoints, true, issues);
  if (selector.prefix !== undefined) opaque ? validateOpaqueText(selector.prefix, `${path}.prefix`, PLAN_LIMITS.selectorContextCodePoints, issues) : validateText(selector.prefix, `${path}.prefix`, PLAN_LIMITS.selectorContextCodePoints, false, issues);
  if (selector.suffix !== undefined) opaque ? validateOpaqueText(selector.suffix, `${path}.suffix`, PLAN_LIMITS.selectorContextCodePoints, issues) : validateText(selector.suffix, `${path}.suffix`, PLAN_LIMITS.selectorContextCodePoints, false, issues);
  if (!Number.isSafeInteger(selector.start) || !Number.isSafeInteger(selector.end) || selector.start < 0 || selector.end <= selector.start) issues.push(issue(path, "invalid-range", "Selector must be a nonempty half-open Unicode code-point range."));
}
function validateSelectorQuote(selector: TextSelector, text: string, path: string, issues: ValidationIssue[]): void { const length = codePointLength(text); if (selector.end > length || selector.start < 0 || selector.end <= selector.start) { issues.push(issue(path, "invalid-range", "Selector range exceeds its text.")); return; } if (sliceCodePoints(text, selector.start, selector.end) !== selector.exact) issues.push(issue(`${path}.exact`, "quote-mismatch", "Selector quote does not match the selected text.")); if (selector.prefix !== undefined && sliceCodePoints(text, Math.max(0, selector.start - codePointLength(selector.prefix)), selector.start) !== selector.prefix) issues.push(issue(`${path}.prefix`, "context-mismatch", "Prefix must be immediate selection context.")); if (selector.suffix !== undefined && sliceCodePoints(text, selector.end, selector.end + codePointLength(selector.suffix)) !== selector.suffix) issues.push(issue(`${path}.suffix`, "context-mismatch", "Suffix must be immediate selection context.")); }

function validateId(value: string, path: string, issues: ValidationIssue[]): void { if (value.length < 1 || value.length > PLAN_LIMITS.idAscii || !/^[!-~]+$/.test(value)) issues.push(issue(path, "invalid-id", "ID must be 1 to 64 printable ASCII characters without spaces.")); }
function validateSafeInteger(value: number, path: string, issues: ValidationIssue[]): void { if (!Number.isSafeInteger(value)) issues.push(issue(path, "unsafe-integer", "Value must be a safe integer.")); }
function validateText(value: string, path: string, maximum: number, nonblank: boolean, issues: ValidationIssue[]): void { if (value.includes("\0")) issues.push(issue(path, "nul", "Text cannot contain NUL.")); validateOpaqueText(value, path, maximum, issues); if (nonblank && value.trim().length === 0) issues.push(issue(path, "blank", "Text cannot be blank.")); }
function validateOpaqueText(value: string, path: string, maximum: number, issues: ValidationIssue[]): void { if (hasUnpairedSurrogate(value)) issues.push(issue(path, "unpaired-surrogate", "Text cannot contain an unpaired UTF-16 surrogate.")); if (codePointLength(value) > maximum) issues.push(issue(path, "too-long", `Text exceeds ${maximum} Unicode code points.`)); }
function validateTimestamp(value: string, path: string, issues: ValidationIssue[]): void { if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) issues.push(issue(path, "invalid-timestamp", "Timestamp must be canonical UTC ISO 8601 with milliseconds.")); }
function uniqueStrings(values: readonly string[], path: string, issues: ValidationIssue[]): void { if (new Set(values).size !== values.length) issues.push(issue(path, "duplicate", "Values must be unique.")); }
function hasUnpairedSurrogate(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (!(next >= 0xdc00 && next <= 0xdfff)) return true; index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return true; } return false; }
export function normalizePlanText(value: string): string { return value.replace(/\r\n?/g, "\n").normalize("NFC"); }
const normalizeCanonicalText = normalizePlanText;
function codePointLength(value: string): number { return [...value].length; }
function sliceCodePoints(value: string, start: number, end: number): string { return [...value].slice(start, end).join(""); }
function utf8Bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function issue(path: string, code: string, message: string): ValidationIssue { return { path, code, message }; }
function success<T>(value: T): ValidationResult<T> { return { ok: true, value }; }
function failure<T = never>(issues: ValidationIssue | readonly ValidationIssue[]): ValidationResult<T> { return { ok: false, issues: Array.isArray(issues) ? issues : [issues] }; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
