import { describe, expect, it, vi } from "vitest";
import { SpecController, formatAcceptedSpec, type SpecControllerOptions } from "../spec/controller.js";
import type { SpecGeneratorResult } from "../spec/generator.js";
import type { SpecSession } from "../spec/types.js";
import { SPEC_LIMITS, validateSpecMarkdown } from "../spec/schema.js";
import { captured, MARKDOWN, NOW, session } from "./spec-fixtures.js";

function harness() {
  let state: SpecSession; let finish!: (result: SpecGeneratorResult) => void; let nextId = 0; let currentSource = captured(); const staged: string[] = [];
  const repository = { commit: vi.fn(async ({ session }: any) => { state = session; return { state: session }; }), commitAccepted: vi.fn(async ({ session }: any) => { state = session; return { state: session }; }), close: vi.fn() };
  const generator = { generate: vi.fn(() => new Promise<SpecGeneratorResult>((resolve) => { finish = resolve; })), configureWriterEndpoint: vi.fn(() => ({ ok: true as const, value: undefined })), submitWriterResult: vi.fn(async () => ({ ok: true as const, value: undefined })), dispatch: vi.fn(() => ({ ok: true as const, value: undefined })), close: vi.fn() };
  const sourceFresh = vi.fn(async () => ({ ok: true as const, value: currentSource }));
  const stage = vi.fn((payload: string) => { staged.push(payload); });
  const options: SpecControllerOptions = { repository, generator, appendLocator: () => undefined, source: { fresh: sourceFresh }, idFactory: () => `id-${++nextId}`, clock: () => NOW, stager: { stage } };
  return { options, repository, generator, sourceFresh, stage, staged, finish: (result: SpecGeneratorResult) => finish(result), setSource: (value: ReturnType<typeof captured>) => { currentSource = value; }, state: () => state! };
}
describe("SpecController", () => {
  it("generates exact Markdown, comments by code point, revises, and addresses only after success", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); expect(created.ok).toBe(true); if (!created.ok) return; const controller = created.value;
    const initial = await controller.generate({ expectedStateVersion: 1 }); expect(initial.ok).toBe(true); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); expect((await initial.value.completion).ok).toBe(true); expect(controller.snapshot()).toMatchObject({ status: "ready", specRevision: 1, markdown: MARKDOWN });
    const start = [...MARKDOWN].join("").indexOf("Build"); const made = await controller.addComment({ expectedStateVersion: 3, start, end: start + 5, body: "Clarify this" }); expect(made.ok).toBe(true); const comment = controller.snapshot().comments[0]!;
    const revised = await controller.revise({ expectedStateVersion: 4, selectedCommentIds: [comment.id] }); expect(revised.ok).toBe(true); if (!revised.ok) return; expect(controller.snapshot().comments[0]!.status).toBe("open"); h.finish({ ok: true, markdown: "# Spec\n\nImplement safely.\n" }); expect((await revised.value.completion).ok).toBe(true); expect(controller.snapshot()).toMatchObject({ status: "ready", specRevision: 2, comments: [{ status: "addressed" }] });
  });
  it("freshness-checks acceptance, commits once, then stages explicit source metadata and exact Markdown", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const initial = await created.value.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); await initial.value.completion; const state = created.value.snapshot(); h.sourceFresh.mockClear(); expect((await created.value.accept({ expectedStateVersion: state.stateVersion, specRevision: 1, confirmed: true })).ok).toBe(true);
    expect(h.sourceFresh).toHaveBeenCalledOnce(); expect(h.repository.commitAccepted).toHaveBeenCalledOnce(); expect(h.stage).toHaveBeenCalledOnce(); expect(h.repository.commitAccepted.mock.invocationCallOrder[0]).toBeLessThan(h.stage.mock.invocationCallOrder[0]!); expect(h.staged[0]).toBe(formatAcceptedSpec(created.value.snapshot())); expect(h.staged[0]!.endsWith(MARKDOWN)).toBe(true); expect(h.staged[0]).toContain("Plan annotations: /tmp/pi-prompt-plans/plan-session/annotations.json"); expect(h.staged[0]).toContain("Grill: /tmp/pi-prompt-plans/plan-session/grill.json#/decisionTree"); expect(h.staged[0]).not.toMatch(/^\/(?:goal|loop) /u);
  });
  it("dispatches immediate implementation so the agent prompt cannot reasonably be read as acknowledgement-only", () => {
    const payload = formatAcceptedSpec(session({ status: "accepted" })); const markdownStart = payload.length - MARKDOWN.length;
    for (const directive of [
      "You are the current main Pi agent. IMPLEMENT the authenticated specification now in the current repository.",
      "Continue through implementation and verification.",
      "Do not merely acknowledge receipt, report readiness, or stop after producing another plan.",
      "The exact accepted Spec Markdown at the end of this message is authoritative. Do not rewrite it before implementation.",
    ]) { const index = payload.indexOf(directive); expect(index).toBeGreaterThanOrEqual(0); expect(index).toBeLessThan(markdownStart); }
    expect(payload.slice(markdownStart)).toBe(MARKDOWN); expect(payload).toContain("Follow the current session's normal permissions and instructions."); expect(payload).toContain("Do not create /create-goal or issue-tracker items.");
  });
  it("preserves each accepted Markdown as one unchanged trailing byte and code-point payload", () => {
    const maxHeader = "# Maximum\r\n\r\n"; const maximal = `${maxHeader}${"x".repeat(SPEC_LIMITS.markdownBytes - Buffer.byteLength(maxHeader, "utf8"))}`;
    const cases = [
      ["BOM", "\uFEFF# BOM Spec\n\nPreserve the leading marker.\n"],
      ["CRLF and Unicode", "# Exact Spec\r\n\r\nShip 😀 café 漢字.\r\n"],
      ["maximum accepted bytes", maximal],
    ] as const;
    for (const [name, markdown] of cases) {
      expect(validateSpecMarkdown(markdown), name).toEqual({ ok: true, value: markdown });
      const payload = formatAcceptedSpec(session({ status: "accepted", markdown })); const markdownStart = payload.length - markdown.length; const suffix = payload.slice(markdownStart);
      expect(payload.indexOf(markdown), name).toBe(markdownStart); expect(payload.lastIndexOf(markdown), name).toBe(markdownStart);
      expect(suffix, name).toBe(markdown); expect(Buffer.compare(Buffer.from(suffix, "utf8"), Buffer.from(markdown, "utf8")), name).toBe(0); expect([...suffix].length, name).toBe([...markdown].length);
      expect(payload.indexOf("IMPLEMENT the authenticated specification"), name).toBeLessThan(markdownStart);
    }
    expect(Buffer.byteLength(maximal, "utf8")).toBe(SPEC_LIMITS.markdownBytes); expect(validateSpecMarkdown("# Spec\0not accepted").ok).toBe(false);
  });
  it("rejects a ready Spec when its source changed without an accepted commit or stage", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const initial = await created.value.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); await initial.value.completion; const ready = created.value.snapshot();
    const source = captured(); h.setSource({ ...source, reference: { ...source.reference, planStateVersion: source.reference.planStateVersion + 1 } });
    await expect(created.value.accept({ expectedStateVersion: ready.stateVersion, specRevision: ready.specRevision, confirmed: true })).resolves.toMatchObject({ ok: false, error: { code: "stale-spec-source" } });
    expect(created.value.snapshot()).toBe(ready); expect(h.repository.commitAccepted).not.toHaveBeenCalled(); expect(h.staged).toEqual([]);
  });
  it("rechecks the captured controller version after the asynchronous freshness check", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const initial = await created.value.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); await initial.value.completion; const ready = created.value.snapshot();
    let entered!: () => void; let resolveFresh!: (value: { readonly ok: true; readonly value: ReturnType<typeof captured> }) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }); const pending = new Promise<{ readonly ok: true; readonly value: ReturnType<typeof captured> }>((resolve) => { resolveFresh = resolve; });
    h.options.source.fresh = vi.fn(() => { entered(); return pending; }); const accepting = created.value.accept({ expectedStateVersion: ready.stateVersion, specRevision: ready.specRevision, confirmed: true }); await started;
    expect((await created.value.addComment({ expectedStateVersion: ready.stateVersion, start: 0, end: 1, body: "Changed while accepting" })).ok).toBe(true); resolveFresh({ ok: true, value: captured() });
    await expect(accepting).resolves.toMatchObject({ ok: false, error: { code: "state-conflict" } }); expect(created.value.snapshot().stateVersion).toBe(ready.stateVersion + 1); expect(h.repository.commitAccepted).not.toHaveBeenCalled(); expect(h.staged).toEqual([]);
  });
  it("serializes concurrent direct acceptance and commits and stages only the winner", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const initial = await created.value.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); await initial.value.completion; const ready = created.value.snapshot();
    let resolveFresh!: (value: { readonly ok: true; readonly value: ReturnType<typeof captured> }) => void; const pending = new Promise<{ readonly ok: true; readonly value: ReturnType<typeof captured> }>((resolve) => { resolveFresh = resolve; }); h.options.source.fresh = vi.fn(() => pending);
    const first = created.value.accept({ expectedStateVersion: ready.stateVersion, specRevision: ready.specRevision, confirmed: true }); const second = created.value.accept({ expectedStateVersion: ready.stateVersion, specRevision: ready.specRevision, confirmed: true }); resolveFresh({ ok: true, value: captured() });
    await expect(first).resolves.toMatchObject({ ok: true }); await expect(second).resolves.toMatchObject({ ok: false, error: { code: "state-conflict" } }); expect(h.repository.commitAccepted).toHaveBeenCalledOnce(); expect(h.staged).toHaveLength(1);
  });
  it("retries staging the exact accepted artifact without rechecking mutable source", async () => {
    const h = harness(); const stage = vi.fn().mockRejectedValueOnce(new Error("not staged")).mockImplementation((payload: string) => { h.staged.push(payload); }); h.options.stager.stage = stage;
    const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const initial = await created.value.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; h.finish({ ok: true, markdown: MARKDOWN }); await initial.value.completion; const ready = created.value.snapshot();
    await expect(created.value.accept({ expectedStateVersion: ready.stateVersion, specRevision: ready.specRevision, confirmed: true })).resolves.toMatchObject({ ok: false, error: { code: "stage-failed" } }); const accepted = created.value.snapshot(); const artifact = formatAcceptedSpec(accepted); const source = captured(); h.setSource({ ...source, reference: { ...source.reference, grillStateVersion: source.reference.grillStateVersion + 1 } }); h.sourceFresh.mockClear();
    await expect(created.value.accept({ expectedStateVersion: accepted.stateVersion, specRevision: accepted.specRevision, confirmed: true })).resolves.toMatchObject({ ok: true }); expect(h.sourceFresh).not.toHaveBeenCalled(); expect(h.repository.commitAccepted).toHaveBeenCalledOnce(); expect(stage).toHaveBeenNthCalledWith(1, artifact); expect(stage).toHaveBeenNthCalledWith(2, artifact); expect(h.staged).toEqual([artifact]);
  });
  it("rebases stale source into an atomic fresh generation and fences the prior job generation", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const controller = created.value;
    const initial = await controller.generate({ expectedStateVersion: 1 }); if (!initial.ok) return; const oldJobId = initial.value.jobId; h.finish({ ok: true, markdown: MARKDOWN }); expect((await initial.value.completion).ok).toBe(true);
    const prior = controller.snapshot(); const base = captured(); const fresh = { ...base, reference: { ...base.reference, planStateVersion: 6, grillStateVersion: 6 } }; h.setSource(fresh);
    await expect(controller.revise({ expectedStateVersion: prior.stateVersion, selectedCommentIds: [] })).resolves.toMatchObject({ ok: false, error: { code: "stale-spec-source" } });
    const rebased = await controller.generateFresh({ expectedStateVersion: prior.stateVersion }); expect(rebased.ok).toBe(true); if (!rebased.ok) return;
    expect(controller.snapshot()).toMatchObject({ stateVersion: prior.stateVersion + 1, specRevision: 0, status: "generating", source: fresh.reference, markdown: null, comments: [], generationJob: { jobId: rebased.value.jobId, operation: "initial", baseSpecRevision: 0, source: fresh.reference } });
    expect(h.repository.commit).toHaveBeenLastCalledWith(expect.objectContaining({ previous: prior, eventKind: "rebased" }));
    await expect(controller.accept({ expectedStateVersion: controller.snapshot().stateVersion, specRevision: 0, confirmed: true })).resolves.toMatchObject({ ok: false, error: { code: "state-conflict" } });
    await expect(controller.submitWriterResult({ planSessionId: prior.planSessionId, jobId: oldJobId, operation: "initial", baseSpecRevision: 0, attemptId: "old-attempt", kind: "spec", body: Buffer.from(MARKDOWN) })).resolves.toMatchObject({ ok: false, error: { code: "writer-submission-stale" } });
    h.finish({ ok: true, markdown: "# Fresh Spec\n\nBuild from the current Grill.\n" }); expect((await rebased.value.completion).ok).toBe(true);
    expect(controller.snapshot()).toMatchObject({ stateVersion: prior.stateVersion + 2, specRevision: 1, status: "ready", source: fresh.reference, markdown: "# Fresh Spec\n\nBuild from the current Grill.\n" });
  });
  it("rejects stale source before creating a generation job", async () => {
    const h = harness(); h.options.source.fresh = async () => ({ ok: false as const, error: { code: "stale-spec-source", message: "stale" } }); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; expect(await created.value.generate({ expectedStateVersion: 1 })).toMatchObject({ ok: false, error: { code: "stale-spec-source" } }); expect(h.generator.generate).not.toHaveBeenCalled();
  });
  it("fences every mutation and stale writer result synchronously while idempotent close drains an active job", async () => {
    const h = harness(); const created = await SpecController.create(h.options, captured()); if (!created.ok) return; const controller = created.value;
    const initial = await controller.generate({ expectedStateVersion: 1 }); if (!initial.ok) return;
    let releaseClose!: () => void; const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; }); h.generator.close.mockImplementation(() => closeGate);
    const firstClose = controller.close(); const secondClose = controller.close();
    expect(secondClose).toBe(firstClose);
    expect(controller.configureWriterEndpoint("http://127.0.0.1/writer")).toMatchObject({ ok: false, error: { code: "controller-closed" } });
    expect(controller.dispatchGeneration(initial.value.jobId)).toMatchObject({ ok: false, error: { code: "controller-closed" } });
    await expect(controller.submitWriterResult({ planSessionId: captured().reference.planSessionId, jobId: initial.value.jobId, operation: "initial", baseSpecRevision: 0, attemptId: "active-attempt", kind: "spec", body: Buffer.from(MARKDOWN) })).resolves.toMatchObject({ ok: false, error: { code: "controller-closed" } });
    const rejected = await Promise.all([
      controller.generate({ expectedStateVersion: 2 }), controller.generateFresh({ expectedStateVersion: 2 }), controller.revise({ expectedStateVersion: 2, selectedCommentIds: [] }),
      controller.addComment({ expectedStateVersion: 2, start: 0, end: 1, body: "blocked" }), controller.editComment({ expectedStateVersion: 2, commentId: "comment", body: "blocked" }),
      controller.transitionComment({ expectedStateVersion: 2, commentId: "comment", status: "dismissed" }), controller.pause({ expectedStateVersion: 2 }), controller.cancel({ expectedStateVersion: 2 }),
      controller.accept({ expectedStateVersion: 2, specRevision: 0, confirmed: true }),
    ]);
    for (const result of rejected) expect(result).toMatchObject({ ok: false, error: { code: "controller-closed" } });
    h.finish({ ok: true, markdown: MARKDOWN });
    await expect(initial.value.completion).resolves.toMatchObject({ ok: false, error: { code: "controller-closed" } });
    expect(h.generator.configureWriterEndpoint).not.toHaveBeenCalled(); expect(h.generator.dispatch).not.toHaveBeenCalled(); expect(h.generator.submitWriterResult).not.toHaveBeenCalled(); expect(h.staged).toEqual([]);
    releaseClose(); await Promise.all([firstClose, secondClose]);
    expect(controller.snapshot()).toMatchObject({ status: "paused", stateVersion: 3, specRevision: 0, generationJob: undefined });
    expect(h.repository.commit).toHaveBeenCalledTimes(3); expect(h.generator.close).toHaveBeenCalledOnce(); expect(h.repository.close).toHaveBeenCalledOnce();
  });
  it.each([
    { operation: "initial" as const, status: "generating" as const, specRevision: 0, markdown: null, normalizedStatus: "paused" as const },
    { operation: "revision" as const, status: "revising" as const, specRevision: 1, markdown: MARKDOWN, normalizedStatus: "error" as const },
  ])("durably normalizes recovered $status jobs and rejects their stale writer results", async ({ operation, status, specRevision, markdown, normalizedStatus }) => {
    const h = harness(); const source = captured().reference; const recovered: SpecSession = { schemaVersion: 1, planSessionId: source.planSessionId, stateVersion: 7, specRevision, status, source, markdown, comments: [], generationJob: { jobId: "recovered-job", operation, baseSpecRevision: specRevision, selectedCommentIds: [], source, startedAt: NOW } };
    const result = await SpecController.fromRecovered(h.options, recovered, []); expect(result.ok).toBe(true); if (!result.ok) return; const controller = result.value;
    expect(controller.snapshot()).toMatchObject({ stateVersion: 8, status: normalizedStatus, generationJob: undefined, lastError: { code: "generation-interrupted" } }); expect(controller.snapshot().markdown).toBe(markdown); expect(controller.snapshot().comments).toEqual([]);
    expect(h.repository.commit).toHaveBeenCalledWith(expect.objectContaining({ previous: recovered, eventKind: "state-changed", session: expect.objectContaining({ status: normalizedStatus, generationJob: undefined }) }));
    await expect(controller.submitWriterResult({ planSessionId: source.planSessionId, jobId: "recovered-job", operation, baseSpecRevision: specRevision, attemptId: "old-attempt", kind: "spec", body: Buffer.from(MARKDOWN) })).resolves.toMatchObject({ ok: false, error: { code: "writer-submission-stale" } }); expect(h.generator.submitWriterResult).not.toHaveBeenCalled();
    const resumed = operation === "initial" ? await controller.generate({ expectedStateVersion: 8 }) : await controller.revise({ expectedStateVersion: 8, selectedCommentIds: [] }); expect(resumed.ok).toBe(true);
  });
});
