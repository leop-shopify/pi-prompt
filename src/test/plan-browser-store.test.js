import { describe, expect, it } from "vitest";
import { allOpenGrillAnnotationIds, availableStage, canAccept, canAcceptSpec, canAddressGrillFeedback, canGenerateFreshSpec, canGenerateSpec, canRetryStaging, canReviseSpec, canRunGrill, canSubmitPlan, createStore, revisionRequestPayload, selectedOpenGrillAnnotationIds, specIsStale, stageAvailability } from "../plan/browser/store.js";

const plan = (patch = {}) => ({ stateVersion: 4, documentRevision: 2, status: "ready", document: { id: "plan" }, annotations: [], ...patch });
const spec = (patch = {}) => ({ stateVersion: 2, specRevision: 1, status: "ready", markdown: "# Spec\n", comments: [], source: { planDocumentRevision: 2, planStateVersion: 4, grillBasedOnDocumentRevision: 2, grillStateVersion: 4 }, actions: { canRetryStaging: false }, ...patch });

describe("staged browser store", () => {
  it("keeps optional Spec reachable without unlocking an absent Adversarial Review", () => {
    expect(stageAvailability(plan())).toEqual({ plan: true, grill: false, spec: true });
    const grilling = plan({ status: "grilling", job: { operation: "grill" } }); expect(stageAvailability(grilling)).toEqual({ plan: true, grill: true, spec: false });
    const grilled = plan({ grill: { basedOnDocumentRevision: 2 } }); expect(stageAvailability(grilled)).toEqual({ plan: true, grill: true, spec: true });
    const store = createStore({ snapshot: grilled, activeStage: "spec" }); expect(store.get().activeStage).toBe("spec"); store.set({ snapshot: plan({ documentRevision: 3 }) }); expect(store.get().activeStage).toBe("spec");
    expect(availableStage("grill", plan())).toBe("plan"); expect(availableStage("spec", plan())).toBe("spec");
    expect(stageAvailability(plan({ status: "error" })).spec).toBe(true); expect(stageAvailability(plan({ status: "awaiting-clarification", clarification: { id: "clarification" } })).spec).toBe(false);
  });

  it("gates independent Spec generation, revision, acceptance, and stale source", () => {
    expect(canGenerateSpec(spec({ status: "paused", markdown: null, specRevision: 0 }))).toBe(true);
    expect(canReviseSpec(spec({ comments: [{ id: "open", status: "open" }] }))).toBe(true);
    expect(canAcceptSpec(spec())).toBe(true);
    expect(specIsStale(plan({ grill: { basedOnDocumentRevision: 2 } }), spec())).toBe(false);
    const planOnlySpec = spec({ source: { planDocumentRevision: 2, planStateVersion: 4 } }); expect(specIsStale(plan(), planOnlySpec)).toBe(false); expect(specIsStale(plan({ grill: { basedOnDocumentRevision: 2 } }), planOnlySpec)).toBe(true); expect(specIsStale(plan(), spec())).toBe(true);
    const annotatedPlan = plan({ stateVersion: 5, annotations: [{ id: "note", author: "user", status: "open" }], grill: { basedOnDocumentRevision: 2 } });
    expect(specIsStale(annotatedPlan, spec())).toBe(true);
    expect(canGenerateFreshSpec(annotatedPlan, spec())).toBe(true);
    expect(canGenerateFreshSpec(annotatedPlan, spec({ job: { operation: "revision" } }))).toBe(false);
    expect(canGenerateFreshSpec(annotatedPlan, spec({ status: "accepted" }))).toBe(false);
    expect(canRunGrill(annotatedPlan, spec())).toBe(true);
  });

  it("keeps Plan submission available after Spec failure but blocks an active Spec job", () => {
    const ready = plan({ grill: { basedOnDocumentRevision: 2 } });
    const failedSpec = spec({ status: "error", markdown: null, specRevision: 0, error: { code: "delegation-failed", message: "Writer failed." } });
    expect(canAccept(ready)).toBe(true);
    expect(canSubmitPlan(ready, failedSpec)).toBe(true);
    const optionalReviewFailure = plan({ status: "error", error: { code: "invalid-grill", message: "Optional review failed." } }); expect(canAccept(optionalReviewFailure)).toBe(true); expect(canSubmitPlan(optionalReviewFailure, null)).toBe(true); expect(canAccept(plan({ status: "error", job: { operation: "grill" } }))).toBe(false);
    expect(canSubmitPlan(ready, spec({ status: "generating", job: { operation: "initial" } }))).toBe(false);
    expect(canSubmitPlan(ready, spec({ status: "revising", job: undefined }))).toBe(false);
    const accepted = plan({ status: "accepted", actions: { canRetryStaging: true } });
    expect(canRetryStaging(accepted)).toBe(true);
    expect(canSubmitPlan(accepted, failedSpec)).toBe(true);
  });

  it("offers Grill recovery without allowing busy, clarification, or terminal reruns", () => {
    expect(canRunGrill(plan(), null)).toBe(true);
    const retainedGrill = plan({ status: "error", grill: { basedOnDocumentRevision: 2 } });
    expect(canRunGrill(retainedGrill, spec())).toBe(true);
    expect(canRunGrill(plan({ job: { operation: "grill" } }), spec())).toBe(false);
    expect(canRunGrill(plan({ status: "awaiting-clarification", clarification: { id: "clarification" } }), spec())).toBe(false);
    expect(canRunGrill(plan({ status: "accepted" }), spec())).toBe(false);
    expect(canRunGrill(plan({ status: "cancelled" }), spec())).toBe(false);
  });

  it("keeps Grill selection stage-local and sends only selected open generated feedback", () => {
    const snapshot = plan({ annotations: [
      { id: "user-open", author: "user", status: "open" },
      { id: "grill-open-b", author: "grill", status: "open" },
      { id: "grill-dismissed", author: "grill", status: "dismissed" },
      { id: "grill-open-a", author: "grill", status: "open" },
    ] });
    const store = createStore({ snapshot, selectedAnnotationIds: ["user-open"], selectedGrillAnnotationIds: ["grill-open-a"] });
    expect(allOpenGrillAnnotationIds(snapshot)).toEqual(["grill-open-b", "grill-open-a"]);
    expect(selectedOpenGrillAnnotationIds(snapshot, ["user-open", "grill-dismissed", "grill-open-b", "grill-open-b"])).toEqual(["grill-open-b"]);
    expect(canAddressGrillFeedback(snapshot, [])).toBe(false);
    expect(canAddressGrillFeedback(snapshot, ["grill-dismissed"])).toBe(false);
    expect(canAddressGrillFeedback(snapshot, ["grill-open-a"])).toBe(true);
    store.set({ selectedGrillAnnotationIds: ["grill-open-a", "grill-open-b"] });
    expect(store.get().selectedAnnotationIds).toEqual(["user-open"]);
    store.set({ activeStage: "plan" });
    expect(store.get().selectedGrillAnnotationIds).toEqual(["grill-open-a", "grill-open-b"]);
    store.set({ selectedGrillAnnotationIds: [] });
    expect(store.get().selectedAnnotationIds).toEqual(["user-open"]);
    expect(revisionRequestPayload(["grill-open-b", "grill-open-a"], "  Keep the fallback modest.  ")).toEqual({ selectedAnnotationIds: ["grill-open-b", "grill-open-a"], instruction: "Keep the fallback modest." });
    expect(revisionRequestPayload(["grill-open-a"], "   ")).toEqual({ selectedAnnotationIds: ["grill-open-a"] });
  });
});
