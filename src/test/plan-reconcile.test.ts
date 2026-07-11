import { describe, expect, it } from "vitest";
import {
  allocateInitialPlanDocument, collectPlanElementIds, createAnnotation, reconcilePlanDocument, reconcileRevision,
  transitionAnnotationStatus,
} from "../plan/reconcile.js";
import { PLAN_LIMITS } from "../plan/schema.js";
import type { Annotation, ModelRevisionPlanDocumentDraft, PlanDocument, RevisionPlanResultDraft } from "../plan/types.js";

const T1 = "2026-07-10T12:00:00.000Z";
const T2 = "2026-07-10T12:01:00.000Z";
const T3 = "2026-07-10T12:02:00.000Z";
const ids = (...values: string[]) => { let index = 0; return () => values[index++] ?? `new-${index}`; };
const initialDraft = () => ({
  title: { kind: "title" as const, body: "Plan", children: [] },
  elements: [
    { kind: "execution" as const, body: "Execute.", children: [] },
    { kind: "step" as const, title: "Build", body: "Alpha quote omega.", children: [] },
  ],
});
const document = (): PlanDocument => ({
  id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] },
  elements: [
    { id: "execution", kind: "execution", body: "Execute.", children: [] },
    { id: "step", kind: "step", title: "Build", body: "Alpha quote omega.", children: [] },
  ],
});
const revisionDraft = (body = "Alpha quote omega.", stepId: string | undefined = "step"): ModelRevisionPlanDocumentDraft => ({
  retainedId: "doc", title: { retainedId: "title", kind: "title", body: "Plan", children: [] },
  elements: [
    { retainedId: "execution", kind: "execution", body: "Execute.", children: [] },
    { ...(stepId === undefined ? {} : { retainedId: stepId }), kind: "step", title: "Build", body, children: [] },
  ],
});
function rangeAnnotation(doc = document()): Annotation {
  const created = createAnnotation(doc, 1, { kind: "range", elementId: "step", selector: { field: "body", start: 6, end: 11, exact: "quote", prefix: "Alpha ", suffix: " omega." } }, "  Explain\r\nthis  ", { idFactory: ids("annotation"), now: T1 });
  if (!created.ok) throw new Error(JSON.stringify(created.issues));
  return created.value;
}
function result(draft: ModelRevisionPlanDocumentDraft, addressedAnnotationIds: readonly string[] = []): RevisionPlanResultDraft {
  return { kind: "revision", document: draft, addressedAnnotationIds };
}

describe("server-owned plan IDs", () => {
  it("allocates root, title, and every element uniquely while retrying collisions", () => {
    const allocated = allocateInitialPlanDocument(initialDraft(), { idFactory: ids("same", "same", "title-id", "exec-id", "step-id"), reservedIds: ["same"] });
    expect(allocated.ok).toBe(true); if (!allocated.ok) return;
    expect([...collectPlanElementIds(allocated.value)]).toEqual(["title-id", "exec-id", "step-id", "new-6"]);
    expect(Object.isFrozen(allocated.value.elements)).toBe(true);
  });

  it("fails safely on exhausted collisions and malicious generated IDs", () => {
    expect(allocateInitialPlanDocument(initialDraft(), { idFactory: () => "taken", reservedIds: ["taken"], maxIdAttempts: 2 }).ok).toBe(false);
    expect(allocateInitialPlanDocument(initialDraft(), { idFactory: () => "has space", maxIdAttempts: 2 }).ok).toBe(false);
  });

  it("retains an absent/equal root ID and rejects a different root", () => {
    const absent = { ...revisionDraft() }; delete (absent as { retainedId?: string }).retainedId;
    expect(reconcilePlanDocument(document(), absent, { idFactory: ids("new") }).ok).toBe(true);
    expect(reconcilePlanDocument(document(), revisionDraft(), { idFactory: ids("new") }).ok).toBe(true);
    expect(reconcilePlanDocument(document(), { ...revisionDraft(), retainedId: "wrong" }, { idFactory: ids("new") }).ok).toBe(false);
  });

  it("allows movement and new nodes but rejects unknown, duplicate, historical, and kind-changing retention", () => {
    const moved = revisionDraft();
    const movedStep = moved.elements[1]!;
    const movement: ModelRevisionPlanDocumentDraft = { ...moved, elements: [{ ...moved.elements[0]!, children: [movedStep] }] };
    expect(reconcilePlanDocument(document(), movement, { idFactory: ids("new") }).ok).toBe(true);
    expect(reconcilePlanDocument(document(), revisionDraft("New", undefined), { idFactory: ids("fresh"), reservedIds: ["deleted"] }).ok).toBe(true);
    expect(reconcilePlanDocument(document(), revisionDraft("New", "deleted"), { idFactory: ids("fresh"), reservedIds: ["deleted"] }).ok).toBe(false);
    expect(reconcilePlanDocument(document(), revisionDraft("New", "unknown"), { idFactory: ids("fresh") }).ok).toBe(false);
    const duplicate = { ...revisionDraft(), elements: [revisionDraft().elements[0]!, { ...revisionDraft().elements[1]!, retainedId: "execution", kind: "execution" as const }] };
    expect(reconcilePlanDocument(document(), duplicate, { idFactory: ids("fresh") }).ok).toBe(false);
    const mutation = { ...revisionDraft(), elements: [revisionDraft().elements[0]!, { ...revisionDraft().elements[1]!, kind: "risk" as const }] };
    expect(reconcilePlanDocument(document(), mutation, { idFactory: ids("fresh") }).ok).toBe(false);
  });
});

describe("annotation capture and reconciliation", () => {
  it("captures root/element snapshots and normalized immutable range fidelity", () => {
    const root = createAnnotation(document(), 1, { kind: "root", elementId: "doc" }, "Root", { idFactory: ids("root-note"), now: T1 });
    const element = createAnnotation(document(), 1, { kind: "element", elementId: "step" }, "Element", { idFactory: ids("element-note"), now: T1 });
    const range = rangeAnnotation();
    expect(root.ok && root.value.targetSnapshot).toMatchObject({ elementKind: "root", text: "" });
    expect(element.ok && element.value.targetSnapshot.text).toBe("Build\nAlpha quote omega.");
    expect(range.body).toBe("  Explain\nthis  ");
    expect(createAnnotation(document(), 1, { kind: "range", elementId: "step", selector: { field: "body", start: 0, end: 1, exact: "wrong" } }, "x", { idFactory: ids("x"), now: T1 }).ok).toBe(false);
  });

  it("keeps unchanged ranges and reanchors insertion using Unicode code-point offsets", () => {
    const annotation = rangeAnnotation();
    const unchanged = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: result(revisionDraft()), selectedAnnotationIds: [], idFactory: ids("unused"), now: T2 });
    expect(unchanged.ok && unchanged.value.annotations[0]?.target).toEqual(annotation.target);
    const inserted = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: result(revisionDraft("😀 New Alpha quote omega.")), selectedAnnotationIds: [], idFactory: ids("unused"), now: T2 });
    expect(inserted.ok && inserted.value.annotations[0]?.target.kind === "range" && inserted.value.annotations[0].target.selector.start).toBe(12);
    expect(inserted.ok && inserted.value.annotations[0]?.targetSnapshot).toEqual(annotation.targetSnapshot);
  });

  it("uses prefix/suffix to disambiguate and orphans ambiguous, removed, or deleted targets", () => {
    const contextual = rangeAnnotation();
    const unique = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [contextual], result: result(revisionDraft("quote -- Alpha quote omega.")), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(unique.ok && unique.value.annotations[0]?.status).toBe("open");
    const noContext = { ...contextual, target: { kind: "range" as const, elementId: "step", selector: { field: "body" as const, start: 6, end: 11, exact: "quote" } }, targetSnapshot: { ...contextual.targetSnapshot, target: { kind: "range" as const, elementId: "step", selector: { field: "body" as const, start: 6, end: 11, exact: "quote" } } } };
    const ambiguous = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [noContext], result: result(revisionDraft("X Moved quote and quote.")), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(ambiguous.ok && ambiguous.value.annotations[0]?.status).toBe("orphaned");
    const removed = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [contextual], result: result(revisionDraft("Removed.")), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(removed.ok && removed.value.annotations[0]?.status).toBe("orphaned");
    const deleted = revisionDraft();
    const withoutStep: ModelRevisionPlanDocumentDraft = { ...deleted, elements: [deleted.elements[0]!] };
    const missing = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [contextual], result: result(withoutStep), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(missing.ok && missing.value.annotations[0]?.status).toBe("orphaned");
  });

  it("restores an orphan only after its retained range uniquely resolves", () => {
    const first = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [rangeAnnotation()], result: result(revisionDraft("Removed.")), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(first.ok).toBe(true); if (!first.ok) return;
    const second = reconcileRevision({ previousDocument: first.value.document, previousRevision: 2, annotations: first.value.annotations, result: result(revisionDraft()), selectedAnnotationIds: [], idFactory: ids("x"), now: T3 });
    expect(second.ok).toBe(true); if (!second.ok) return;
    expect(second.value.annotations[0]).toMatchObject({ status: "open", history: [{ from: "open", to: "orphaned", at: T2 }, { from: "orphaned", to: "open", at: T3 }] });
    expect(second.value.annotations[0]?.targetSnapshot).toEqual(rangeAnnotation().targetSnapshot);
  });

  it("enforces addressed selection, user-owned dismissal, and orphan precedence", () => {
    const annotation = rangeAnnotation();
    const unknown = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: result(revisionDraft(), ["unknown"]), selectedAnnotationIds: [annotation.id], idFactory: ids("x"), now: T2 });
    const unrequested = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: result(revisionDraft(), [annotation.id]), selectedAnnotationIds: [], idFactory: ids("x"), now: T2 });
    expect(unknown.ok).toBe(false); expect(unrequested.ok).toBe(false);
    const dismissed = transitionAnnotationStatus(annotation, "dismissed", { actor: "user", now: T2 }); expect(dismissed.ok).toBe(true); if (!dismissed.ok) return;
    const kept = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [dismissed.value], result: result(revisionDraft(), [annotation.id]), selectedAnnotationIds: [annotation.id], idFactory: ids("x"), now: T3 });
    expect(kept.ok && kept.value.annotations[0]?.status).toBe("dismissed");
    const orphanWins = reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: result(revisionDraft("Removed."), [annotation.id]), selectedAnnotationIds: [annotation.id], idFactory: ids("x"), now: T2 });
    expect(orphanWins.ok && orphanWins.value.annotations[0]?.status).toBe("orphaned");
    if (orphanWins.ok) expect(transitionAnnotationStatus(orphanWins.value.annotations[0]!, "open", { actor: "user", now: T3 }).ok).toBe(false);
    expect(reconcileRevision({ previousDocument: document(), previousRevision: 1, annotations: [annotation], result: { ...result(revisionDraft()), addressedAnnotationIds: [annotation.id, annotation.id] }, selectedAnnotationIds: [annotation.id], idFactory: ids("x"), now: T2 }).ok).toBe(false);
  });

  it("bounds history while preserving the first transition and newest status without mutation", () => {
    const original = rangeAnnotation(); let current = original;
    for (let index = 0; index < PLAN_LIMITS.history + 5; index += 1) {
      const to = current.status === "open" ? "addressed" : "open";
      const changed = transitionAnnotationStatus(current, to, { actor: to === "open" ? "user" : "model", requestedByRevision: true, now: T2 });
      expect(changed.ok).toBe(true); if (!changed.ok) return; current = changed.value;
    }
    expect(current.history.length).toBeLessThanOrEqual(PLAN_LIMITS.history);
    expect(current.history[0]).toMatchObject({ from: "open", to: "addressed" });
    expect(current.history.at(-1)?.to).toBe(current.status);
    expect(original).toEqual(rangeAnnotation());
  });
});
