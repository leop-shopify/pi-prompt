import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanController } from "../plan/controller.js";
import type { PlanHttpHost, PlanHttpHostOptions } from "../plan/http-server.js";
import type { PlanSession } from "../plan/types.js";

const startHost = vi.hoisted(() => vi.fn());
vi.mock("../plan/http-server.js", () => ({ startPlanHttpHost: startHost }));

import { createBrowserPlanReviewPort } from "../extension/browser-review-port.js";

function generatingState(id: string): PlanSession {
  return {
    schemaVersion: 1, id, stateVersion: 1, documentRevision: 0, status: "generating",
    source: { prompt: `Prompt ${id}`, cwd: "/private", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" },
    document: null, annotations: [],
    generationJob: { jobId: `job-${id}`, operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-14T00:00:00.000Z" },
  };
}

function controller(state: PlanSession): PlanController {
  return { snapshot: vi.fn(() => state), acceptedStagingPending: vi.fn(() => false) } as unknown as PlanController;
}

function host(port: number): PlanHttpHost & { close: ReturnType<typeof vi.fn> } {
  let closed = false;
  const close = vi.fn(async () => { closed = true; });
  return { port, origin: `http://127.0.0.1:${port}`, launchUrl: `http://127.0.0.1:${port}/#capability=${"a".repeat(43)}`, get closed() { return closed; }, close };
}

function context() {
  const setStatus = vi.fn();
  return { ctx: { ui: { setStatus } } as unknown as ExtensionContext, setStatus };
}

describe("BrowserReviewPort terminal host cleanup", () => {
  beforeEach(() => startHost.mockReset());

  it("clears the matching footer and references but ignores an obsolete host callback after replacement", async () => {
    const firstHost = host(41001); const secondHost = host(41002); const starts: PlanHttpHostOptions[] = [];
    startHost.mockImplementation(async (options: PlanHttpHostOptions) => { starts.push(options); return starts.length === 1 ? firstHost : secondHost; });
    const launcher = { open: vi.fn(async () => undefined) };
    const port = createBrowserPlanReviewPort({ launcher, reopen: vi.fn() });
    const firstState = generatingState("first"); const secondState = generatingState("second");
    const firstController = controller(firstState); const secondController = controller(secondState);
    const firstContext = context(); const secondContext = context();

    await port.start?.({ controller: firstController, state: firstState, ctx: firstContext.ctx });
    await port.start?.({ controller: secondController, state: secondState, ctx: secondContext.ctx });
    expect(firstHost.close).toHaveBeenCalledOnce();
    expect(secondContext.setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", expect.any(String));

    const firstCallCount = firstContext.setStatus.mock.calls.length; const secondCallCount = secondContext.setStatus.mock.calls.length;
    await starts[0]!.onTerminalClose?.(firstHost);
    expect(firstContext.setStatus).toHaveBeenCalledTimes(firstCallCount); expect(secondContext.setStatus).toHaveBeenCalledTimes(secondCallCount);

    await secondHost.close(); await starts[1]!.onTerminalClose?.(secondHost);
    expect(secondContext.setStatus).toHaveBeenLastCalledWith("pi-prompt-plan", undefined);
    expect(secondContext.setStatus).toHaveBeenCalledTimes(secondCallCount + 1);
    await port.close?.();
    expect(secondHost.close).toHaveBeenCalledOnce();
  });
});
