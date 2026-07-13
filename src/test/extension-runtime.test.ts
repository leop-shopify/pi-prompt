import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createPromptExtensionRuntime } from "../extension/runtime.js";
import type { ControllerStackFactory } from "../extension/controller-factory.js";
import type { PlanController } from "../plan/controller.js";
import type { PlanSession } from "../plan/types.js";
import type { PromptEditorSubmission } from "../prompt-editor/types.js";

const submission: PromptEditorSubmission = { text: "Build it", mode: "careful", execution: { kind: "normal" }, selectedSkills: [], saveAsTemplate: false };
function empty(status: "paused" | "generating" = "paused"): PlanSession {
  return { schemaVersion: 1, id: "session", stateVersion: status === "paused" ? 1 : 2, documentRevision: 0, status, source: { prompt: "Build it", cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "careful" }, document: null, annotations: [], ...(status === "generating" ? { generationJob: { jobId: "job", operation: "initial" as const, baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" } } : {}) };
}
function ready(): PlanSession { return { ...empty(), stateVersion: 3, documentRevision: 1, status: "ready", document: { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [{ id: "execution", kind: "execution", body: "Normal", children: [] }] } }; }
function context(): ExtensionContext { return { cwd: "/repo", mode: "tui", isIdle: () => true, ui: { notify: vi.fn(), confirm: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), setEditorText: vi.fn() }, sessionManager: { getBranch: () => [] } } as unknown as ExtensionContext; }
function controllerHarness() {
  let state = empty(); let finish!: (value: any) => void;
  const listeners = new Set<(event: any) => void>();
  const completion = new Promise<any>((resolve) => { finish = resolve; });
  const controller = {
    snapshot: vi.fn(() => state),
    subscribe: vi.fn((listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    configureWriterEndpoint: vi.fn(() => ({ ok: true, value: undefined })),
    generate: vi.fn(async () => { state = empty("generating"); return { ok: true, value: { jobId: "job", completion } }; }),
    dispatchGeneration: vi.fn(() => ({ ok: true, value: undefined })),
    pause: vi.fn(async () => { state = { ...state, stateVersion: state.stateVersion + 1, status: "paused", generationJob: undefined } as PlanSession; return { ok: true, value: undefined }; }),
    verifySkills: vi.fn(async () => ({ ok: true, value: undefined })), resumeReview: vi.fn(async () => ({ ok: true, value: undefined })),
    acceptedStagingPending: vi.fn(() => false), accept: vi.fn(), close: vi.fn(async () => undefined),
    setReady: () => { state = ready(); },
    cancelPlan: () => { state = { ...state, stateVersion: state.stateVersion + 1, status: "cancelled", generationJob: undefined } as PlanSession; for (const listener of listeners) listener({ kind: "cancelled", sessionId: state.id, status: "cancelled", stateVersion: state.stateVersion, documentRevision: state.documentRevision }); },
    setCancelled: () => { state = { ...state, status: "cancelled", generationJob: undefined } as PlanSession; },
    finish,
  };
  return controller as unknown as PlanController & typeof controller;
}
function runtimeFor(controller: PlanController, review: any) {
  const create = vi.fn(async () => ({ ok: true as const, value: { controller, loadedSkills: { references: [], contexts: [] } } }));
  const recover = vi.fn(async () => ({ ok: true as const, value: { controller, state: controller.snapshot(), warnings: [], reservedIds: [] } }));
  const planDrafts = { upsert: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  return { runtime: createPromptExtensionRuntime({ controllers: { create, recover } as unknown as ControllerStackFactory, review, editor: { open: vi.fn() }, planDrafts }), create, recover, planDrafts };
}

describe("extension runtime", () => {
  it("durably starts, opens the browser, then dispatches, and returns before completion", async () => {
    const order: string[] = []; const controller = controllerHarness();
    controller.generate.mockImplementation(async () => { order.push("durable"); return { ok: true, value: { jobId: "job", completion: new Promise(() => undefined) } } as any; });
    controller.dispatchGeneration.mockImplementation(() => { order.push("dispatch"); return { ok: true, value: undefined }; });
    const review = { start: vi.fn(async () => { order.push("endpoint"); controller.configureWriterEndpoint("http://127.0.0.1:43210/api/v1/writer-results"); order.push("browser"); }), ready: vi.fn() };
    const { runtime } = runtimeFor(controller, review); const ctx = context();
    await runtime.generate(ctx, submission);
    expect(order).toEqual(["durable", "endpoint", "browser", "dispatch"]);
    expect(controller.configureWriterEndpoint).toHaveBeenCalledBefore(controller.dispatchGeneration);
    expect(controller.snapshot()?.status).toBe("paused");
  });

  it("auto-saves one deterministic restart draft and removes it only after cancellation", async () => {
    const controller = controllerHarness(); const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() };
    const { runtime, planDrafts } = runtimeFor(controller, review);
    await runtime.generate(context(), submission);
    expect(planDrafts.upsert).toHaveBeenCalledOnce();
    expect(planDrafts.upsert).toHaveBeenCalledWith("session", "Build it");
    expect(planDrafts.remove).not.toHaveBeenCalled();
    controller.cancelPlan();
    await vi.waitFor(() => expect(planDrafts.remove).toHaveBeenCalledWith("session"));
  });

  it("keeps the restart draft on lifecycle close and removes a stale draft for recovered cancellation", async () => {
    const active = controllerHarness(); const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() };
    const generated = runtimeFor(active, review);
    await generated.runtime.generate(context(), submission); await generated.runtime.beforeTree();
    expect(generated.planDrafts.remove).not.toHaveBeenCalled();

    const cancelled = controllerHarness(); cancelled.setCancelled();
    const recovered = runtimeFor(cancelled, review);
    await recovered.runtime.resume(context());
    expect(recovered.planDrafts.remove).toHaveBeenCalledWith("session");
    expect(recovered.planDrafts.upsert).not.toHaveBeenCalled();
  });

  it("pauses safely and never dispatches when the private review host cannot start", async () => {
    const controller = controllerHarness(); const review = { start: vi.fn(async () => { throw new Error("host failed"); }), ready: vi.fn() };
    const { runtime } = runtimeFor(controller, review); const ctx = context();
    await runtime.generate(ctx, submission);
    expect(controller.dispatchGeneration).not.toHaveBeenCalled(); expect(controller.pause).toHaveBeenCalledWith({ expectedStateVersion: 2 });
    expect(controller.snapshot()?.status).toBe("paused"); expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("paused before writer dispatch"), "error");
  });

  it("publishes the ready plan asynchronously and clears terminal progress when completion settles", async () => {
    const controller = controllerHarness(); const review = { start: vi.fn(), ready: vi.fn() }; const { runtime } = runtimeFor(controller, review); const ctx = context();
    await runtime.generate(ctx, submission); expect(review.ready).not.toHaveBeenCalled();
    controller.setReady(); controller.finish({ ok: true, value: undefined });
    await vi.waitFor(() => expect(review.ready).toHaveBeenCalledWith(expect.objectContaining({ controller, state: expect.objectContaining({ status: "ready" }) })));
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", undefined);
  });

  it("normalizes a recovered active Grill job before presenting its materialized artifacts for review", async () => {
    const artifact = { basedOnDocumentRevision: 1, annotationIds: { concern: "grill-note" }, decisionTree: { rootNodeId: "root", nodes: [{ id: "root", question: "Proceed?", annotationKeys: ["concern"], options: [] }] }, generatedAt: "2026-07-11T00:00:00.000Z" };
    let state = { ...ready(), status: "grilling" as const, stateVersion: 8,
      annotations: [{ id: "grill-note", author: "grill" as const, target: { kind: "element" as const, elementId: "execution" }, targetSnapshot: { documentRevision: 1, target: { kind: "element" as const, elementId: "execution" }, elementKind: "execution" as const, text: "Normal" }, body: "Confirm the normal path.", status: "open" as const, history: [], createdAgainstRevision: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }], grill: artifact,
      generationJob: { jobId: "phantom-grill", operation: "grill" as const, baseDocumentRevision: 1, selectedAnnotationIds: [], startedAt: "2026-07-11T00:01:00.000Z" } } as PlanSession;
    const controller = {
      snapshot: vi.fn(() => state), close: vi.fn(async () => undefined), acceptedStagingPending: vi.fn(() => false),
      pause: vi.fn(async ({ expectedStateVersion }: { expectedStateVersion: number }) => {
        expect(expectedStateVersion).toBe(8);
        state = { ...state, stateVersion: 9, status: "paused", generationJob: undefined } as PlanSession;
        return { ok: true, value: undefined };
      }),
      verifySkills: vi.fn(async ({ expectedStateVersion }: { expectedStateVersion: number }) => {
        expect(expectedStateVersion).toBe(9);
        return { ok: true, value: undefined };
      }),
      resumeReview: vi.fn(async ({ expectedStateVersion }: { expectedStateVersion: number }) => {
        expect(expectedStateVersion).toBe(9);
        state = { ...state, stateVersion: 10, status: "ready" } as PlanSession;
        return { ok: true, value: undefined };
      }),
    } as unknown as PlanController;
    const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() }; const { runtime } = runtimeFor(controller, review);
    await runtime.resume(context());
    expect((controller as any).pause).toHaveBeenCalledWith({ expectedStateVersion: 8 });
    expect((controller as any).resumeReview).toHaveBeenCalledWith({ expectedStateVersion: 9 });
    expect(state).toMatchObject({ status: "ready", generationJob: undefined, grill: artifact });
    expect(review.ready).toHaveBeenCalledWith(expect.objectContaining({ controller, state: expect.objectContaining({ status: "ready", generationJob: undefined, grill: artifact }) }));
    expect(review.start).not.toHaveBeenCalled();
  });

  it("leaves an already-ready recovered plan reviewable without interruption", async () => {
    const controller = controllerHarness(); controller.setReady();
    const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() }; const { runtime } = runtimeFor(controller, review);
    await runtime.resume(context());
    expect(controller.pause).not.toHaveBeenCalled();
    expect(controller.resumeReview).not.toHaveBeenCalled();
    expect(review.ready).toHaveBeenCalledWith(expect.objectContaining({ controller, state: expect.objectContaining({ status: "ready" }) }));
  });

  it("resumes an interrupted answered clarification continuation from its persisted origin", async () => {
    const question = { id: "question", prompt: "Which variant?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    const interrupted = { ...ready(), status: "error" as const, stateVersion: 8,
      annotations: [{ id: "note", target: { kind: "element" as const, elementId: "execution" }, targetSnapshot: { documentRevision: 1, target: { kind: "element" as const, elementId: "execution" }, elementKind: "execution" as const, text: "Normal" }, body: "Keep locked origin", status: "open" as const, history: [], createdAgainstRevision: 1, createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z" }],
      clarifications: { history: [{ id: "batch", questions: [question], answers: [{ questionId: "question", answer: { kind: "option" as const, optionId: "a" } }], answeredAt: "2026-07-11T00:01:00.000Z" }], origin: { operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: ["note"], instruction: "Preserve origin" } },
      lastError: { code: "interrupted", message: "Interrupted safely" },
    } as PlanSession;
    let state = interrupted; const completion = new Promise<any>(() => undefined);
    const controller = {
      snapshot: vi.fn(() => state), close: vi.fn(async () => undefined), acceptedStagingPending: vi.fn(() => false),
      verifySkills: vi.fn(async () => ({ ok: true, value: undefined })),
      resumeClarification: vi.fn(async () => {
        expect(state.clarifications).toEqual(interrupted.clarifications);
        state = { ...state, status: "revising", stateVersion: 9, generationJob: { jobId: "continued-job", ...interrupted.clarifications!.origin!, startedAt: "2026-07-11T00:02:00.000Z" } } as PlanSession;
        return { ok: true, value: { jobId: "continued-job", completion } };
      }),
      dispatchGeneration: vi.fn(() => ({ ok: true, value: undefined })),
    } as unknown as PlanController;
    const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() }; const { runtime } = runtimeFor(controller, review);
    await runtime.resume(context());
    expect((controller as any).resumeClarification).toHaveBeenCalledWith({ expectedStateVersion: 8 });
    expect((controller as any).dispatchGeneration).toHaveBeenCalledWith("continued-job");
    expect(review.start).toHaveBeenCalledWith(expect.objectContaining({ state: expect.objectContaining({ generationJob: expect.objectContaining({ selectedAnnotationIds: ["note"], instruction: "Preserve origin" }) }) }));
    expect(review.ready).not.toHaveBeenCalled();
  });

  it("closes browser first and controller second on lifecycle pause", async () => {
    const order: string[] = []; const controller = controllerHarness(); controller.close.mockImplementation(async () => { order.push("controller"); });
    const { runtime } = runtimeFor(controller, { start: vi.fn(), ready: vi.fn(), close: vi.fn(async () => { order.push("browser"); }) });
    await runtime.generate(context(), submission); await runtime.beforeTree();
    expect(order).toEqual(["browser", "controller"]);
  });

  it("keeps lifecycle close retryable and ignores late completion", async () => {
    const controller = controllerHarness(); const review = { start: vi.fn(), ready: vi.fn(), close: vi.fn() }; const { runtime } = runtimeFor(controller, review);
    await runtime.generate(context(), submission); controller.close.mockRejectedValueOnce(new Error("private")).mockResolvedValueOnce(undefined);
    expect(await runtime.beforeTree()).toBe(false); expect(await runtime.shutdown()).toBe(true);
    controller.setReady(); controller.finish({ ok: true, value: undefined }); await Promise.resolve();
    expect(review.ready).not.toHaveBeenCalled();
  });
});
