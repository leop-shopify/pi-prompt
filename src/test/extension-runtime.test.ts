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
  const completion = new Promise<any>((resolve) => { finish = resolve; });
  const controller = {
    snapshot: vi.fn(() => state),
    generate: vi.fn(async () => { state = empty("generating"); return { ok: true, value: { jobId: "job", completion } }; }),
    dispatchGeneration: vi.fn(() => ({ ok: true, value: undefined })),
    pause: vi.fn(async () => { state = { ...state, stateVersion: state.stateVersion + 1, status: "paused", generationJob: undefined } as PlanSession; return { ok: true, value: undefined }; }),
    verifySkills: vi.fn(async () => ({ ok: true, value: undefined })), resumeReview: vi.fn(async () => ({ ok: true, value: undefined })),
    acceptedStagingPending: vi.fn(() => false), accept: vi.fn(), close: vi.fn(async () => undefined),
    setReady: () => { state = ready(); }, finish,
  };
  return controller as unknown as PlanController & typeof controller;
}
function runtimeFor(controller: PlanController, review: any) {
  const create = vi.fn(async () => ({ ok: true as const, value: { controller, loadedSkills: { references: [], contexts: [] } } }));
  const recover = vi.fn(async () => ({ ok: true as const, value: { controller, state: controller.snapshot(), warnings: [], reservedIds: [] } }));
  return { runtime: createPromptExtensionRuntime({ controllers: { create, recover } as unknown as ControllerStackFactory, review, editor: { open: vi.fn() } }), create, recover };
}

describe("extension runtime", () => {
  it("durably starts, opens the browser, then dispatches, and returns before completion", async () => {
    const order: string[] = []; const controller = controllerHarness();
    controller.generate.mockImplementation(async () => { order.push("durable"); return { ok: true, value: { jobId: "job", completion: new Promise(() => undefined) } } as any; });
    controller.dispatchGeneration.mockImplementation(() => { order.push("dispatch"); return { ok: true, value: undefined }; });
    const review = { start: vi.fn(async () => { order.push("browser"); }), ready: vi.fn() };
    const { runtime } = runtimeFor(controller, review); const ctx = context();
    await runtime.generate(ctx, submission);
    expect(order).toEqual(["durable", "browser", "dispatch"]);
    expect(controller.snapshot()?.status).toBe("paused");
  });

  it("publishes the ready plan asynchronously when completion settles", async () => {
    const controller = controllerHarness(); const review = { start: vi.fn(), ready: vi.fn() }; const { runtime } = runtimeFor(controller, review);
    await runtime.generate(context(), submission); expect(review.ready).not.toHaveBeenCalled();
    controller.setReady(); controller.finish({ ok: true, value: undefined });
    await vi.waitFor(() => expect(review.ready).toHaveBeenCalledWith(expect.objectContaining({ controller, state: expect.objectContaining({ status: "ready" }) })));
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
