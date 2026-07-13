import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { startPlanHttpHost } from "../plan/http-server.js";
import type { PlanController } from "../plan/controller.js";
import type { SpecController } from "../spec/controller.js";
import { session } from "./spec-fixtures.js";

function planController(): PlanController { return { snapshot: vi.fn(() => null), subscribe: vi.fn(() => () => undefined), configureWriterEndpoint: vi.fn(() => ({ ok: true, value: undefined })), submitWriterResult: vi.fn(), acceptedStagingPending: vi.fn(() => false) } as unknown as PlanController; }
function specController() {
  let state = session({ status: "revising", stateVersion: 3, generationJob: { jobId: "spec-job", operation: "revision", baseSpecRevision: 1, selectedCommentIds: [], source: session().source, startedAt: "2026-07-12T00:00:00.000Z" } });
  const raw = { snapshot: vi.fn(() => state), subscribe: vi.fn(() => () => undefined), configureWriterEndpoint: vi.fn(() => ({ ok: true as const, value: undefined })), submitWriterResult: vi.fn(async () => ({ ok: true as const, value: undefined })), acceptedStagingPending: vi.fn(() => false), close: vi.fn(async () => undefined), revise: vi.fn(), generate: vi.fn(), generateFresh: vi.fn(), dispatchGeneration: vi.fn(), addComment: vi.fn(), editComment: vi.fn(), transitionComment: vi.fn(), accept: vi.fn(), pause: vi.fn(), cancel: vi.fn() };
  return { controller: raw as unknown as SpecController, raw, set: (next: typeof state) => { state = next; } };
}
function browserHeaders(host: Awaited<ReturnType<typeof startPlanHttpHost>>) { const capability = new URL(host.launchUrl).hash.slice("#capability=".length); return { Authorization: `Bearer ${capability}`, "X-Pi-Prompt-Origin": host.origin }; }
describe("shared hardened Spec HTTP surface", () => {
  it("serves isolated snapshots with Spec ETags and routes authenticated spec bytes only to the active Spec controller", async () => {
    const spec = specController(); const plan = planController(); const host = await startPlanHttpHost({ controller: plan, specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const snapshot = await fetch(`${host.origin}/api/v1/spec/snapshot`, { headers: browserHeaders(host) }); expect(snapshot.status).toBe(200); expect(snapshot.headers.get("etag")).toBe('"pi-spec-state-3"'); expect(await snapshot.json()).toMatchObject({ snapshot: { planSessionId: "plan-session", specRevision: 1 } });
      const body = Buffer.from("# Revised Spec\n\nExact.\n", "utf8"); const upload = await fetch(`${host.origin}/api/v1/writer-results`, { method: "POST", headers: { Authorization: "Bearer attempt_identity_0001", "Content-Type": "text/markdown", "X-Pi-Prompt-Result": "spec" }, body });
      expect(upload.status).toBe(202); expect(spec.raw.submitWriterResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "spec", planSessionId: "plan-session", jobId: "spec-job", baseSpecRevision: 1, body })); expect(plan.submitWriterResult).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });
  it("serves exact Spec Markdown bytes with a leading BOM", async () => {
    const spec = specController(); const markdown = "\uFEFF# Exact Spec\n\nBody.\n"; spec.set(session({ status: "ready", markdown }));
    const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const response = await fetch(`${host.origin}/api/v1/spec/markdown`, { headers: browserHeaders(host) });
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/markdown");
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
      expect(decoded).toBe(markdown); expect(decoded.codePointAt(0)).toBe(0xfeff);
    } finally { await host.close(); }
  });
  it("rejects a valid-looking random Spec writer bearer without creating a sidecar or running factory side effects", async () => {
    const locate = vi.fn(); const commit = vi.fn(); const sidecar = specController();
    const createSpecController = vi.fn(async () => { locate(); commit(); return sidecar.controller; }); const plan = planController();
    const host = await startPlanHttpHost({ controller: plan, createSpecController, reopenInPi: vi.fn() });
    try {
      const body = Buffer.from("# Uncorrelated Spec\n", "utf8"); const bearer = randomBytes(24).toString("base64url");
      const upload = await fetch(`${host.origin}/api/v1/writer-results`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "text/markdown", "X-Pi-Prompt-Result": "spec" }, body });
      expect(upload.status).toBe(401); expect(await upload.json()).toMatchObject({ error: { code: "writer-submission-stale" } });
      expect(createSpecController).not.toHaveBeenCalled(); expect(locate).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(plan.submitWriterResult).not.toHaveBeenCalled();
    } finally { await host.close(); }
    expect(sidecar.raw.configureWriterEndpoint).not.toHaveBeenCalled(); expect(sidecar.raw.close).not.toHaveBeenCalled();
  });
  it("creates the injected Spec sidecar lazily once and preserves its separate ETag", async () => {
    const spec = specController(); const factory = vi.fn(async () => spec.controller); const host = await startPlanHttpHost({ controller: planController(), createSpecController: factory, reopenInPi: vi.fn() });
    try {
      const first = await fetch(`${host.origin}/api/v1/spec/snapshot`, { headers: browserHeaders(host) }); const second = await fetch(`${host.origin}/api/v1/spec/snapshot`, { headers: browserHeaders(host) });
      expect(first.status).toBe(200); expect(first.headers.get("etag")).toBe('"pi-spec-state-3"'); expect(second.status).toBe(200); expect(factory).toHaveBeenCalledOnce(); expect(spec.raw.configureWriterEndpoint).toHaveBeenCalledWith(`${host.origin}/api/v1/writer-results`);
    } finally { await host.close(); }
    expect(spec.raw.close).toHaveBeenCalledOnce();
  });
  it("closes a pending lazy Spec sidecar without installing it when the host closes", async () => {
    const spec = specController(); let beginFactory!: () => void; let resolveFactory!: (value: SpecController | null) => void;
    const factoryStarted = new Promise<void>((resolve) => { beginFactory = resolve; });
    const factoryResult = new Promise<SpecController | null>((resolve) => { resolveFactory = resolve; });
    const factory = vi.fn(() => { beginFactory(); return factoryResult; });
    const host = await startPlanHttpHost({ controller: planController(), createSpecController: factory, reopenInPi: vi.fn() });
    const pending = fetch(`${host.origin}/api/v1/spec/snapshot`, { headers: browserHeaders(host) });
    await factoryStarted;
    const closing = host.close();
    resolveFactory(spec.controller);
    const response = await pending;
    await closing;
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "closing" } }); expect(host.closed).toBe(true); expect(factory).toHaveBeenCalledOnce();
    expect(spec.raw.close).toHaveBeenCalledOnce(); expect(spec.raw.configureWriterEndpoint).not.toHaveBeenCalled(); expect(spec.raw.subscribe).not.toHaveBeenCalled();
  });
  it("rejects a queued keep-alive Spec mutation when host close begins before its dispatch turn", async () => {
    const spec = specController(); let entered!: () => void; let release!: () => void; const queuedCommit = vi.fn();
    const started = new Promise<void>((resolve) => { entered = resolve; }); const blocked = new Promise<void>((resolve) => { release = resolve; });
    spec.raw.addComment.mockImplementation(async () => { if (spec.raw.addComment.mock.calls.length === 1) { entered(); await blocked; } else queuedCommit(); return { ok: true as const, value: undefined }; });
    const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    const token = new URL(host.launchUrl).hash.slice("#capability=".length);
    const request = (requestId: string, connection: "keep-alive" | "close"): string => {
      const body = JSON.stringify({ requestId, start: 0, end: 1, body: "queued" });
      return ["POST /api/v1/spec/comments HTTP/1.1", `Host: 127.0.0.1:${host.port}`, `Authorization: Bearer ${token}`, `X-Pi-Prompt-Origin: ${host.origin}`, `Origin: ${host.origin}`, "Content-Type: application/json", 'If-Match: "pi-spec-state-3"', `Content-Length: ${Buffer.byteLength(body)}`, `Connection: ${connection}`, "", body].join("\r\n");
    };
    const responses = new Promise<string>((resolve, reject) => {
      const socket = connect(host.port, "127.0.0.1"); let raw = ""; socket.setEncoding("utf8"); socket.once("error", reject); socket.on("data", (chunk) => { raw += chunk; }); socket.once("close", () => resolve(raw));
      socket.once("connect", () => socket.write(request("request-id-spec-blocker", "keep-alive") + request("request-id-spec-queued", "close")));
    });
    await started; await new Promise<void>((resolve) => setImmediate(resolve));
    const closing = host.close(); release(); const raw = await responses; await closing;
    expect(raw.match(/HTTP\/1\.1 503 Service Unavailable/gu)).toHaveLength(2); expect(raw.match(/"code":"closing"/gu)).toHaveLength(2);
    expect(spec.raw.addComment).toHaveBeenCalledOnce(); expect(queuedCommit).not.toHaveBeenCalled(); expect(host.closed).toBe(true);
  });
  it("replays one authenticated fresh-generation rebase without starting duplicate jobs", async () => {
    const spec = specController(); const ready = session({ stateVersion: 3, status: "ready" }); spec.set(ready);
    spec.raw.generateFresh.mockImplementation(async () => { const next = session({ stateVersion: 4, specRevision: 0, status: "generating", markdown: null, comments: [], generationJob: { jobId: "fresh-job", operation: "initial", baseSpecRevision: 0, selectedCommentIds: [], source: ready.source, startedAt: "2026-07-12T00:00:00.000Z" } }); spec.set(next); return { ok: true as const, value: { jobId: "fresh-job", completion: new Promise(() => undefined) } }; });
    spec.raw.dispatchGeneration.mockReturnValue({ ok: true as const, value: undefined });
    const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const headers = { ...browserHeaders(host), Origin: host.origin, "Content-Type": "application/json", "If-Match": '"pi-spec-state-3"' }; const body = JSON.stringify({ requestId: "request-id-spec-fresh-01" });
      const first = await fetch(`${host.origin}/api/v1/spec/fresh-generations`, { method: "POST", headers, body }); const replay = await fetch(`${host.origin}/api/v1/spec/fresh-generations`, { method: "POST", headers, body });
      expect(first.status).toBe(202); expect(replay.status).toBe(202); expect(await first.json()).toMatchObject({ snapshot: { stateVersion: 4, status: "generating", specRevision: 0, markdown: null } }); expect(await replay.json()).toEqual(expect.objectContaining({ snapshot: expect.objectContaining({ stateVersion: 4 }) }));
      expect(spec.raw.generateFresh).toHaveBeenCalledOnce(); expect(spec.raw.generateFresh).toHaveBeenCalledWith({ expectedStateVersion: 3 }); expect(spec.raw.dispatchGeneration).toHaveBeenCalledOnce();
    } finally { await host.close(); }
  });
  it("rejects an accept body version that differs from If-Match before replay or controller dispatch", async () => {
    const spec = specController(); spec.set(session({ stateVersion: 3, status: "ready" }));
    spec.raw.accept.mockImplementation(async () => { spec.set(session({ stateVersion: 4, status: "accepted" })); return { ok: true as const, value: undefined }; });
    const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const headers = { ...browserHeaders(host), Origin: host.origin, "Content-Type": "application/json", "If-Match": '"pi-spec-state-3"' }; const requestId = "request-id-spec-version-fence";
      const stale = await fetch(`${host.origin}/api/v1/spec/accept`, { method: "POST", headers, body: JSON.stringify({ requestId, stateVersion: 2, specRevision: 1, confirmed: true }) });
      expect(stale.status).toBe(409); expect(stale.headers.get("etag")).toBe('"pi-spec-state-3"'); expect(await stale.json()).toMatchObject({ error: { code: "state-conflict" }, current: { stateVersion: 3, specRevision: 1 }, snapshot: { status: "ready" } });
      expect(spec.raw.accept).not.toHaveBeenCalled(); expect(spec.raw.snapshot()).toMatchObject({ stateVersion: 3, status: "ready" });
      const matching = await fetch(`${host.origin}/api/v1/spec/accept`, { method: "POST", headers, body: JSON.stringify({ requestId, stateVersion: 3, specRevision: 1, confirmed: true }) });
      expect(matching.status).toBe(200); expect(spec.raw.accept).toHaveBeenCalledOnce(); expect(spec.raw.accept).toHaveBeenCalledWith({ expectedStateVersion: 3, specRevision: 1, confirmed: true });
    } finally { await host.close(); }
  });
  it("fences concurrent multi-tab HTTP acceptance with the committed Spec version", async () => {
    const spec = specController(); const ready = session({ stateVersion: 3, status: "ready" }); spec.set(ready); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }); const blocked = new Promise<void>((resolve) => { release = resolve; });
    spec.raw.accept.mockImplementation(async () => { entered(); await blocked; spec.set(session({ stateVersion: 4, status: "accepted" })); return { ok: true as const, value: undefined }; });
    const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const headers = { ...browserHeaders(host), Origin: host.origin, "Content-Type": "application/json", "If-Match": '"pi-spec-state-3"' };
      const request = (requestId: string) => fetch(`${host.origin}/api/v1/spec/accept`, { method: "POST", headers, body: JSON.stringify({ requestId, stateVersion: 3, specRevision: 1, confirmed: true }) });
      const firstPending = request("request-id-spec-accept-01"); await started; const secondPending = request("request-id-spec-accept-02"); release(); const [first, second] = await Promise.all([firstPending, secondPending]);
      expect(first.status).toBe(200); expect(await first.json()).toMatchObject({ snapshot: { stateVersion: 4, status: "accepted" } }); expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ error: { code: "state-conflict" }, current: { stateVersion: 4, specRevision: 1 } }); expect(spec.raw.accept).toHaveBeenCalledOnce();
    } finally { await host.close(); }
  });
  it("rejects plan ETags on Spec mutations and rejects spec results when no active Spec job exists", async () => {
    const spec = specController(); spec.set(session({ stateVersion: 4, status: "ready" })); const host = await startPlanHttpHost({ controller: planController(), specController: spec.controller, reopenInPi: vi.fn() });
    try {
      const headers = { ...browserHeaders(host), Origin: host.origin, "Content-Type": "application/json", "If-Match": '"pi-plan-state-4"' }; const response = await fetch(`${host.origin}/api/v1/spec/revisions`, { method: "POST", headers, body: JSON.stringify({ requestId: "request-id-spec-0001", selectedCommentIds: [] }) }); expect(response.status).toBe(400);
      const body = Buffer.from("# Spec\n"); const upload = await fetch(`${host.origin}/api/v1/writer-results`, { method: "POST", headers: { Authorization: "Bearer attempt_identity_0001", "Content-Type": "text/markdown", "X-Pi-Prompt-Result": "spec" }, body }); expect(upload.status).toBe(401); expect(spec.raw.submitWriterResult).not.toHaveBeenCalled();
    } finally { await host.close(); }
  });
});
