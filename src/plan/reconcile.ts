import {
  PLAN_LIMITS, normalizePlanText, validateInitialPlanResult, validatePlanAnnotations, validatePlanDocument,
  validateRevisionPlanResult,
} from "./schema.js";
import type {
  Annotation, AnnotationHistoryEntry, AnnotationStatus, AnnotationTarget, AnnotationTargetSnapshot,
  ModelPlanDocumentDraft, ModelPlanElementDraft, ModelRevisionPlanDocumentDraft, ModelRevisionPlanElementDraft,
  PlanDocument, PlanElement, PlanElementKind, RevisionPlanResultDraft, TextSelector, ValidationIssue, ValidationResult,
} from "./types.js";

export type PlanIdFactory = () => string;

export interface PlanIdOptions {
  readonly idFactory: PlanIdFactory;
  readonly reservedIds?: Iterable<string>;
  readonly maxIdAttempts?: number;
}

export interface AnnotationMutationOptions extends PlanIdOptions {
  readonly now: string;
}

export interface StatusTransitionOptions {
  readonly actor: "user" | "model" | "system";
  readonly now: string;
  readonly requestedByRevision?: boolean;
}

export interface ReconcileRevisionInput extends PlanIdOptions {
  readonly previousDocument: PlanDocument;
  readonly previousRevision: number;
  readonly annotations: readonly Annotation[];
  readonly result: RevisionPlanResultDraft;
  readonly selectedAnnotationIds: readonly string[];
  readonly now: string;
}

export interface ReconciledRevision {
  readonly document: PlanDocument;
  readonly annotations: readonly Annotation[];
  readonly documentRevision: number;
}

const DEFAULT_ID_ATTEMPTS = 8;

export function collectPlanElementIds(document: PlanDocument): ReadonlySet<string> {
  const ids = new Set<string>([document.id]);
  const visit = (element: PlanElement): void => { ids.add(element.id); element.children.forEach(visit); };
  visit(document.title); document.elements.forEach(visit);
  return ids;
}

export function indexPlanElements(document: PlanDocument): ReadonlyMap<string, PlanElement> {
  const elements = new Map<string, PlanElement>();
  const visit = (element: PlanElement): void => { elements.set(element.id, element); element.children.forEach(visit); };
  visit(document.title); document.elements.forEach(visit);
  return elements;
}

export function allocateInitialPlanDocument(draft: ModelPlanDocumentDraft, options: PlanIdOptions): ValidationResult<PlanDocument> {
  const parsed = validateInitialPlanResult({ kind: "plan", document: draft });
  if (!parsed.ok || parsed.value.kind !== "plan") return parsed.ok ? fail("$", "invalid-draft", "Expected an initial plan draft.") : parsed;
  const reservedResult = makeReserved(options);
  if (!reservedResult.ok) return reservedResult;
  const reserved = reservedResult.value;
  const root = allocateId(options, reserved, "$.id"); if (!root.ok) return root;
  const title = materializeInitialElement(parsed.value.document.title, options, reserved, "$.title"); if (!title.ok) return title;
  const elements: PlanElement[] = [];
  for (let index = 0; index < parsed.value.document.elements.length; index += 1) {
    const element = materializeInitialElement(parsed.value.document.elements[index], options, reserved, `$.elements[${index}]`);
    if (!element.ok) return element; elements.push(element.value);
  }
  return validatePlanDocument({ id: root.value, title: title.value, elements });
}

export function reconcilePlanDocument(previous: PlanDocument, draft: ModelRevisionPlanDocumentDraft, options: PlanIdOptions): ValidationResult<PlanDocument> {
  const previousResult = validatePlanDocument(previous); if (!previousResult.ok) return previousResult;
  const parsed = validateRevisionPlanResult({ kind: "revision", document: draft, addressedAnnotationIds: [] });
  if (!parsed.ok) return parsed;
  const normalizedDraft = parsed.value.document;
  if (normalizedDraft.retainedId !== undefined && normalizedDraft.retainedId !== previousResult.value.id) {
    return fail("$.document.retainedId", "invalid-retained-id", "The document retainedId must equal the immediately previous document ID.");
  }
  const reservedResult = makeReserved(options, collectPlanElementIds(previousResult.value)); if (!reservedResult.ok) return reservedResult;
  const reserved = reservedResult.value;
  const previousElements = indexPlanElements(previousResult.value); const retained = new Set<string>();
  const title = materializeRevisionElement(normalizedDraft.title, options, reserved, previousElements, retained, "$.document.title"); if (!title.ok) return title;
  const elements: PlanElement[] = [];
  for (let index = 0; index < normalizedDraft.elements.length; index += 1) {
    const element = materializeRevisionElement(normalizedDraft.elements[index], options, reserved, previousElements, retained, `$.document.elements[${index}]`);
    if (!element.ok) return element; elements.push(element.value);
  }
  return validatePlanDocument({ id: previousResult.value.id, title: title.value, elements });
}

export function validateAnnotationTarget(document: PlanDocument, documentRevision: number, target: AnnotationTarget): ValidationResult<AnnotationTargetSnapshot> {
  const documentResult = validatePlanDocument(document); if (!documentResult.ok) return documentResult;
  if (!Number.isSafeInteger(documentRevision) || documentRevision < 1) return fail("$.documentRevision", "invalid-revision", "Document revision must be a positive safe integer.");
  if (target.kind === "root") {
    if (target.elementId !== documentResult.value.id) return fail("$.target.elementId", "unknown-target", "Root target must equal the current document ID.");
    return ok({ documentRevision, target: { kind: "root", elementId: target.elementId }, elementKind: "root", text: "" });
  }
  const element = indexPlanElements(documentResult.value).get(target.elementId);
  if (!element) return fail("$.target.elementId", "unknown-target", "Annotation target does not exist in the current document.");
  if (target.kind === "element") {
    return ok({ documentRevision, target: { kind: "element", elementId: target.elementId }, elementKind: element.kind, text: canonicalElementText(element) });
  }
  const selector = normalizeSelector(target.selector); const text = fieldText(element, selector.field);
  if (text === undefined) return fail("$.target.selector.field", "missing-field", "Selected field does not exist on the target element.");
  const selectorIssue = validateSelector(selector, text); if (selectorIssue) return { ok: false, issues: [selectorIssue] };
  return ok({ documentRevision, target: { kind: "range", elementId: target.elementId, selector }, elementKind: element.kind, text });
}

export function createAnnotation(
  document: PlanDocument, documentRevision: number, target: AnnotationTarget, body: string, options: AnnotationMutationOptions,
): ValidationResult<Annotation> {
  const snapshot = validateAnnotationTarget(document, documentRevision, target); if (!snapshot.ok) return snapshot;
  const reservedResult = makeReserved(options, collectPlanElementIds(document)); if (!reservedResult.ok) return reservedResult;
  const id = allocateId(options, reservedResult.value, "$.id"); if (!id.ok) return id;
  const normalizedBody = normalizePlanText(body);
  const annotation: Annotation = {
    id: id.value, target: snapshot.value.target, targetSnapshot: snapshot.value, body: normalizedBody, status: "open", history: [],
    createdAgainstRevision: documentRevision, createdAt: options.now, updatedAt: options.now,
  };
  const validated = validatePlanAnnotations([annotation], document, documentRevision);
  return validated.ok ? ok(validated.value[0] ?? annotation) : validated;
}

export function transitionAnnotationStatus(
  annotation: Annotation, to: AnnotationStatus, options: StatusTransitionOptions,
): ValidationResult<Annotation> {
  const from = annotation.status;
  if (from === to) return fail("$.status", "invalid-transition", "A status transition must change status.");
  const allowed = options.actor === "user"
    ? ((to === "open" && (from === "addressed" || from === "dismissed")) || (to === "dismissed" && (from === "open" || from === "addressed")))
    : options.actor === "model"
      ? from === "open" && to === "addressed" && options.requestedByRevision === true
      : (to === "orphaned" && from !== "orphaned") || (from === "orphaned" && to === annotation.statusBeforeOrphan);
  if (!allowed) return fail("$.status", "forbidden-transition", "The actor does not own this annotation status transition.");
  if (!isTimestamp(options.now) || options.now < annotation.updatedAt) return fail("$.updatedAt", "invalid-timestamp", "Transition time must be canonical and chronological.");
  const history = appendHistory(annotation.history, { from, to, at: options.now });
  if (to === "orphaned") {
    if (from === "orphaned") return fail("$.status", "invalid-transition", "An orphaned annotation cannot be orphaned twice.");
    return ok({ ...annotation, status: to, history, updatedAt: options.now, statusBeforeOrphan: from });
  }
  const { statusBeforeOrphan: _removed, ...withoutOrphanState } = annotation;
  return ok({ ...withoutOrphanState, status: to, history, updatedAt: options.now });
}

export function reconcileAnnotations(
  annotations: readonly Annotation[], document: PlanDocument, documentRevision: number,
  options: { readonly now: string; readonly addressedAnnotationIds?: readonly string[] },
): ValidationResult<readonly Annotation[]> {
  if (!isTimestamp(options.now)) return fail("$.now", "invalid-timestamp", "Reconciliation time must be canonical UTC ISO 8601.");
  const addressed = new Set(options.addressedAnnotationIds ?? []);
  if (addressed.size !== (options.addressedAnnotationIds?.length ?? 0)) return fail("$.addressedAnnotationIds", "duplicate", "Addressed annotation IDs must be unique.");
  const known = new Set(annotations.map((annotation) => annotation.id));
  for (const id of addressed) if (!known.has(id)) return fail("$.addressedAnnotationIds", "unknown-annotation", "Addressed annotation ID is unknown.");
  const elements = indexPlanElements(document); const output: Annotation[] = [];
  for (const annotation of annotations) {
    let next = reconcileOneAnnotation(annotation, document, elements, options.now);
    if (!next.ok) return next;
    if (addressed.has(annotation.id) && annotation.status === "open" && next.value.status === "open") {
      next = transitionAnnotationStatus(next.value, "addressed", { actor: "model", now: options.now, requestedByRevision: true });
      if (!next.ok) return next;
    }
    output.push(next.value);
  }
  return validatePlanAnnotations(output, document, documentRevision);
}

export function reconcileRevision(input: ReconcileRevisionInput): ValidationResult<ReconciledRevision> {
  if (!Number.isSafeInteger(input.previousRevision) || input.previousRevision < 1) return fail("$.previousRevision", "invalid-revision", "Previous revision must be a positive safe integer.");
  const previousDocument = validatePlanDocument(input.previousDocument); if (!previousDocument.ok) return previousDocument;
  const previousAnnotations = validatePlanAnnotations(input.annotations, previousDocument.value, input.previousRevision); if (!previousAnnotations.ok) return previousAnnotations;
  const parsed = validateRevisionPlanResult(input.result); if (!parsed.ok) return parsed;
  const selected = new Set(input.selectedAnnotationIds);
  if (selected.size !== input.selectedAnnotationIds.length) return fail("$.selectedAnnotationIds", "duplicate", "Selected annotation IDs must be unique.");
  const annotationIds = new Set(previousAnnotations.value.map((annotation) => annotation.id));
  for (const id of selected) if (!annotationIds.has(id)) return fail("$.selectedAnnotationIds", "unknown-annotation", "Selected annotation ID is unknown.");
  for (const id of parsed.value.addressedAnnotationIds) {
    if (!annotationIds.has(id)) return fail("$.addressedAnnotationIds", "unknown-annotation", "Addressed annotation ID is unknown.");
    if (!selected.has(id)) return fail("$.addressedAnnotationIds", "unrequested-annotation", "A model may address only annotations selected for this revision.");
  }
  const revisionReserved = new Set(input.reservedIds ?? []); previousAnnotations.value.forEach((annotation) => revisionReserved.add(annotation.id));
  const document = reconcilePlanDocument(previousDocument.value, parsed.value.document, { ...input, reservedIds: revisionReserved }); if (!document.ok) return document;
  const documentRevision = input.previousRevision + 1;
  const annotations = reconcileAnnotations(previousAnnotations.value, document.value, documentRevision, { now: input.now, addressedAnnotationIds: parsed.value.addressedAnnotationIds });
  if (!annotations.ok) return annotations;
  return ok({ document: document.value, annotations: annotations.value, documentRevision });
}

function materializeInitialElement(draft: ModelPlanElementDraft, options: PlanIdOptions, reserved: Set<string>, path: string): ValidationResult<PlanElement> {
  const id = allocateId(options, reserved, `${path}.id`); if (!id.ok) return id;
  const children: PlanElement[] = [];
  for (let index = 0; index < draft.children.length; index += 1) {
    const child = materializeInitialElement(draft.children[index], options, reserved, `${path}.children[${index}]`); if (!child.ok) return child; children.push(child.value);
  }
  return ok(elementValue(id.value, draft.kind, draft.title, draft.body, children));
}

function materializeRevisionElement(
  draft: ModelRevisionPlanElementDraft, options: PlanIdOptions, reserved: Set<string>, previous: ReadonlyMap<string, PlanElement>, retained: Set<string>, path: string,
): ValidationResult<PlanElement> {
  let id: string;
  if (draft.retainedId !== undefined) {
    const old = previous.get(draft.retainedId);
    if (!old) return fail(`${path}.retainedId`, "invalid-retained-id", "retainedId must identify an element in the immediately previous document.");
    if (retained.has(draft.retainedId)) return fail(`${path}.retainedId`, "duplicate-retained-id", "Each retainedId may be used at most once.");
    if (old.kind !== draft.kind) return fail(`${path}.kind`, "retained-kind-change", "A retained element must preserve its kind.");
    retained.add(draft.retainedId); id = draft.retainedId;
  } else {
    const allocated = allocateId(options, reserved, `${path}.id`); if (!allocated.ok) return allocated; id = allocated.value;
  }
  const children: PlanElement[] = [];
  for (let index = 0; index < draft.children.length; index += 1) {
    const child = materializeRevisionElement(draft.children[index], options, reserved, previous, retained, `${path}.children[${index}]`); if (!child.ok) return child; children.push(child.value);
  }
  return ok(elementValue(id, draft.kind, draft.title, draft.body, children));
}

function elementValue(id: string, kind: PlanElementKind, title: string | undefined, body: string, children: readonly PlanElement[]): PlanElement {
  return { id, kind, ...(title === undefined ? {} : { title }), body, children };
}

function makeReserved(options: PlanIdOptions, current: Iterable<string> = []): ValidationResult<Set<string>> {
  const attempts = options.maxIdAttempts ?? DEFAULT_ID_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 64) return fail("$.maxIdAttempts", "invalid-option", "maxIdAttempts must be a safe integer from 1 through 64.");
  const reserved = new Set<string>(current);
  for (const id of options.reservedIds ?? []) {
    if (!validId(id)) return fail("$.reservedIds", "invalid-id", "Reserved IDs must satisfy the plan ID rule.");
    reserved.add(id);
  }
  return ok(reserved);
}

function allocateId(options: PlanIdOptions, reserved: Set<string>, path: string): ValidationResult<string> {
  const attempts = options.maxIdAttempts ?? DEFAULT_ID_ATTEMPTS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let candidate: string;
    try { candidate = options.idFactory(); } catch { return fail(path, "id-allocation-failed", "ID generation failed safely."); }
    if (typeof candidate === "string" && validId(candidate) && !reserved.has(candidate)) { reserved.add(candidate); return ok(candidate); }
  }
  return fail(path, "id-allocation-exhausted", "Could not allocate a unique valid ID within the bounded attempt count.");
}

function reconcileOneAnnotation(annotation: Annotation, document: PlanDocument, elements: ReadonlyMap<string, PlanElement>, now: string): ValidationResult<Annotation> {
  if (annotation.target.kind === "root") return annotation.target.elementId === document.id ? ok({ ...annotation }) : orphan(annotation, now);
  const element = elements.get(annotation.target.elementId);
  if (!element) return orphan(annotation, now);
  if (annotation.target.kind === "element") return annotation.status === "orphaned" ? ok({ ...annotation }) : ok({ ...annotation });
  const text = fieldText(element, annotation.target.selector.field);
  if (text === undefined) return orphan(annotation, now);
  const selector = locateSelector(annotation.target.selector, text, annotation.status === "orphaned");
  if (!selector) return orphan(annotation, now);
  const target: AnnotationTarget = { kind: "range", elementId: annotation.target.elementId, selector };
  const changed = !sameSelector(annotation.target.selector, selector);
  if (annotation.status === "orphaned") {
    const restored = annotation.statusBeforeOrphan;
    if (restored === undefined) return fail("$.statusBeforeOrphan", "orphan-status", "Orphaned annotation is missing its prior status.");
    const transitioned = transitionAnnotationStatus({ ...annotation, target }, restored, { actor: "system", now });
    return transitioned;
  }
  return ok(changed ? { ...annotation, target, updatedAt: now } : { ...annotation });
}

function orphan(annotation: Annotation, now: string): ValidationResult<Annotation> {
  if (annotation.status === "orphaned") return ok({ ...annotation });
  const target = annotation.target.kind === "range" && annotation.targetSnapshot.target.kind === "range"
    ? annotation.targetSnapshot.target : annotation.target;
  return transitionAnnotationStatus({ ...annotation, target }, "orphaned", { actor: "system", now });
}

function locateSelector(selector: TextSelector, text: string, requireUnique: boolean): TextSelector | undefined {
  if (!requireUnique && selectorMatches(selector, text, selector.start)) return selector;
  const exact = [...selector.exact]; const source = [...text]; const matches: number[] = [];
  for (let start = 0; start + exact.length <= source.length; start += 1) {
    if (source.slice(start, start + exact.length).join("") === selector.exact && selectorMatches(selector, text, start)) matches.push(start);
  }
  if (matches.length !== 1) return undefined;
  const start = matches[0]; if (start === undefined) return undefined;
  return { ...selector, start, end: start + exact.length };
}

function selectorMatches(selector: TextSelector, text: string, start: number): boolean {
  const exactLength = codePointLength(selector.exact); const end = start + exactLength;
  if (sliceCodePoints(text, start, end) !== selector.exact) return false;
  if (selector.prefix !== undefined && sliceCodePoints(text, Math.max(0, start - codePointLength(selector.prefix)), start) !== selector.prefix) return false;
  return selector.suffix === undefined || sliceCodePoints(text, end, end + codePointLength(selector.suffix)) === selector.suffix;
}

function normalizeSelector(selector: TextSelector): TextSelector {
  return {
    field: selector.field, start: selector.start, end: selector.end, exact: normalizePlanText(selector.exact),
    ...(selector.prefix === undefined ? {} : { prefix: normalizePlanText(selector.prefix) }),
    ...(selector.suffix === undefined ? {} : { suffix: normalizePlanText(selector.suffix) }),
  };
}

function validateSelector(selector: TextSelector, text: string): ValidationIssue | undefined {
  if (!Number.isSafeInteger(selector.start) || !Number.isSafeInteger(selector.end) || selector.start < 0 || selector.end <= selector.start) return issue("$.target.selector", "invalid-range", "Selector must be a nonempty half-open Unicode code-point range.");
  if (codePointLength(selector.exact) > PLAN_LIMITS.selectorExactCodePoints || selector.exact.trim().length === 0) return issue("$.target.selector.exact", "invalid-exact", "Selector exact text is blank or too long.");
  if ((selector.prefix !== undefined && codePointLength(selector.prefix) > PLAN_LIMITS.selectorContextCodePoints) || (selector.suffix !== undefined && codePointLength(selector.suffix) > PLAN_LIMITS.selectorContextCodePoints)) return issue("$.target.selector", "context-too-long", "Selector context is too long.");
  if (selector.end > codePointLength(text) || sliceCodePoints(text, selector.start, selector.end) !== selector.exact) return issue("$.target.selector.exact", "quote-mismatch", "Selector quote does not match the normalized field text.");
  return selectorMatches(selector, text, selector.start) ? undefined : issue("$.target.selector", "context-mismatch", "Selector context must be immediate normalized field context.");
}

function appendHistory(history: readonly AnnotationHistoryEntry[], entry: AnnotationHistoryEntry): readonly AnnotationHistoryEntry[] {
  const all = [...history, entry]; if (all.length <= PLAN_LIMITS.history) return all;
  const first = all[0]; if (first === undefined) return [];
  let start = all.length - (PLAN_LIMITS.history - 1);
  while (start < all.length && all[start]?.from !== first.to) start += 1;
  if (start < all.length) return [first, ...all.slice(start)];
  const tail = all.slice(all.length - (PLAN_LIMITS.history - 2)); const boundary = tail[0];
  if (boundary === undefined || first.to === boundary.to) return [first, ...tail.slice(1)];
  return [first, { from: first.to, to: boundary.to, at: boundary.at }, ...tail.slice(1)];
}

function canonicalElementText(element: PlanElement): string { return `${element.title === undefined ? "" : `${element.title}\n`}${element.body}`; }
function fieldText(element: PlanElement, field: TextSelector["field"]): string | undefined { return field === "title" ? element.title : element.body; }
function sameSelector(left: TextSelector, right: TextSelector): boolean { return left.field === right.field && left.start === right.start && left.end === right.end && left.exact === right.exact && left.prefix === right.prefix && left.suffix === right.suffix; }
function validId(value: string): boolean { return value.length >= 1 && value.length <= PLAN_LIMITS.idAscii && /^[!-~]+$/.test(value); }
function isTimestamp(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value; }
function codePointLength(value: string): number { return [...value].length; }
function sliceCodePoints(value: string, start: number, end: number): string { return [...value].slice(start, end).join(""); }
function issue(path: string, code: string, message: string): ValidationIssue { return { path, code, message }; }
function ok<T>(value: T): ValidationResult<T> { return { ok: true, value }; }
function fail<T = never>(path: string, code: string, message: string): ValidationResult<T> { return { ok: false, issues: [issue(path, code, message)] }; }
