import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startPlanHttpHost, SECURITY_HEADERS } from "../plan/http-server.js";
import type { PlanController, PlanControllerEvent } from "../plan/controller.js";
import type { PlanSession } from "../plan/types.js";

function readyState(overrides: Partial<PlanSession> = {}): PlanSession {
  return {
    schemaVersion: 1, id: "session", stateVersion: 3, documentRevision: 1, status: "ready",
    source: { prompt: "PRIVATE SOURCE", cwd: "/private/cwd", skills: [{ name: "private", path: "/private/SKILL.md", baseDir: "/private", sha256: "a".repeat(64) }] },
    execution: { kind: "normal" }, generation: { mode: "normal" },
    document: { id: "document", title: { id: "title", kind: "title", body: "Hostile </script><img onerror=1>", children: [] }, elements: [{ id: "execution", kind: "execution", body: "Normal, staged only", children: [] }, { id: "step", kind: "step", title: "Build", body: "Do it", children: [] }] }, annotations: [], ...overrides,
  } as PlanSession;
}
function fakeController(initial = readyState(), behavior: { stageFailures?: number } = {}) {
  let state = initial;
  let stageFailures = behavior.stageFailures ?? 0;
  let staged = false; let writerSettled = false;
  const writerSubmissions: Array<{ readonly attemptId: string; readonly kind: string; readonly body: Buffer }> = [];
  const listeners = new Set<(event: PlanControllerEvent) => void>();
  let note = 0; let job = 0;
  const publish = (kind = "state-changed") => { for (const listener of listeners) listener({ kind: kind as any, sessionId: state.id, status: state.status, stateVersion: state.stateVersion, documentRevision: state.documentRevision }); };
  const commit = (patch: Partial<PlanSession>, kind?: string) => { state = { ...state, stateVersion: state.stateVersion + 1, ...patch } as PlanSession; publish(kind); return { ok: true as const, value: undefined }; };
  const controller = {
    snapshot: vi.fn(() => state),
    configureWriterEndpoint: vi.fn(() => ({ ok: true as const, value: undefined })),
    submitWriterResult: vi.fn(async ({ attemptId, kind, body }: any) => {
      if (attemptId !== "attempt_identity_0001" || writerSettled) return { ok: false as const, error: { code: "writer-attempt-rejected", message: "The writer submission is not active." } };
      if (kind === "clarification") {
        try { const value = JSON.parse(body.toString("utf8")); if (!value || Object.keys(value).length !== 1 || !Array.isArray(value.questions) || value.questions.length === 0) throw new Error("invalid"); }
        catch { return { ok: false as const, error: { code: "invalid-clarification", message: "The clarification submission is invalid." } }; }
      }
      writerSubmissions.push({ attemptId, kind, body }); writerSettled = true; return { ok: true as const, value: undefined };
    }),
    subscribe: vi.fn((listener: (event: PlanControllerEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); }),
    addAnnotation: vi.fn(async ({ target, body }: any) => state.status === "awaiting-clarification" ? { ok: false as const, error: { code: "clarification-read-only", message: "Annotations are read-only while clarification answers are pending." } } : commit({ annotations: [...state.annotations, { id: `note-${++note}`, target, targetSnapshot: { documentRevision: state.documentRevision, target, elementKind: target.kind === "root" ? "root" : "step", text: target.kind === "root" ? "" : "Do it" }, body, status: "open", history: [], createdAgainstRevision: state.documentRevision, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }] })),
    updateAnnotationBody: vi.fn(async ({ annotationId, body }: any) => state.status === "awaiting-clarification" ? { ok: false as const, error: { code: "clarification-read-only", message: "Annotations are read-only while clarification answers are pending." } } : commit({ annotations: state.annotations.map((entry) => entry.id === annotationId ? { ...entry, body } : entry) })),
    transitionAnnotation: vi.fn(async ({ annotationId, status }: any) => state.status === "awaiting-clarification" ? { ok: false as const, error: { code: "clarification-read-only", message: "Annotations are read-only while clarification answers are pending." } } : commit({ annotations: state.annotations.map((entry) => entry.id === annotationId ? { ...entry, status } : entry) })),
    revise: vi.fn(async ({ selectedAnnotationIds }: any) => { const id = `job-${++job}`; commit({ status: "revising", generationJob: { jobId: id, operation: "revision", baseDocumentRevision: state.documentRevision, selectedAnnotationIds, startedAt: "2026-07-10T00:00:00.000Z" } }); return { ok: true as const, value: { jobId: id, completion: new Promise(() => undefined) } }; }),
    grill: vi.fn(async () => { const id = `job-${++job}`; commit({ status: "grilling", generationJob: { jobId: id, operation: "grill", baseDocumentRevision: state.documentRevision, selectedAnnotationIds: [], startedAt: "2026-07-10T00:00:00.000Z" } }); return { ok: true as const, value: { jobId: id, completion: new Promise(() => undefined) } }; }),
    generate: vi.fn(async () => { const id = `job-${++job}`; commit({ status: "generating" }); return { ok: true as const, value: { jobId: id, completion: new Promise(() => undefined) } }; }),
    answerClarification: vi.fn(async () => { const id = `job-${++job}`; const operation = state.clarifications?.pending?.operation ?? "initial"; commit({ status: operation === "initial" ? "generating" : "revising", clarifications: { history: state.clarifications?.history ?? [], origin: state.clarifications?.origin }, generationJob: { jobId: id, operation, baseDocumentRevision: state.documentRevision, selectedAnnotationIds: [], startedAt: "2026-07-10T00:00:00.000Z" } }); return { ok: true as const, value: { jobId: id, completion: new Promise(() => undefined) } }; }),
    dispatchGeneration: vi.fn(() => ({ ok: true as const, value: undefined })),
    acceptedStagingPending: vi.fn(() => state.status === "accepted" && !staged),
    accept: vi.fn(async () => {
      if (state.status === "ready") commit({ status: "accepted" }, "accepted");
      if (stageFailures > 0) { stageFailures -= 1; return { ok: false as const, error: { code: "stage-failed", message: "The accepted plan was saved but could not be staged." } }; }
      staged = true; return { ok: true as const, value: undefined };
    }),
    pause: vi.fn(async () => commit({ status: "paused", generationJob: undefined }, "paused")),
    cancel: vi.fn(async () => commit({ status: "cancelled", generationJob: undefined }, "cancelled")),
  };
  return { controller: controller as unknown as PlanController, raw: controller, getState: () => state, listeners, writerSubmissions };
}
function auth(host: Awaited<ReturnType<typeof startPlanHttpHost>>, mutation = false, etag?: string) {
  const token = new URL(host.launchUrl).hash.slice("#capability=".length);
  return { Authorization: `Bearer ${token}`, "X-Pi-Prompt-Origin": host.origin, ...(mutation ? { Origin: host.origin, "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) } : {}) };
}
function writerHeaders(attemptId: string, result: "plan" | "clarification" | "grill", contentType = result === "plan" ? "text/markdown" : "application/json") {
  return { Authorization: `Bearer ${attemptId}`, "Content-Type": contentType, "X-Pi-Prompt-Result": result };
}
async function json(response: Response) { return response.json() as Promise<any>; }

describe("secure plan HTTP host", () => {
  it("starts a correlated Grill run and accepts strict-JSON writer bytes", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const run = await fetch(`${host.origin}/api/v1/grill-runs`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-grill-001" }) });
      expect(run.status).toBe(202); expect(fake.raw.grill).toHaveBeenCalledWith({ expectedStateVersion: 3 }); expect(await json(run)).toMatchObject({ job: { status: "grilling" } });
      const bytes = Buffer.from('{"kind":"grill"}'); const upload = await fetch(`${host.origin}/api/v1/writer-results`, { method: "POST", headers: writerHeaders("attempt_identity_0001", "grill"), body: bytes });
      expect(upload.status).toBe(202); expect(fake.writerSubmissions[0]).toMatchObject({ kind: "grill", body: bytes });
    } finally { await host.close(); }
  });

  it("serves only the constant shell/allowlisted assets with security headers and no private plan data", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const shell = await fetch(host.origin); const text = await shell.text();
      expect(shell.status).toBe(200); expect(text).toContain("Plan review");
      expect(text).not.toContain("Hostile"); expect(text).not.toContain("PRIVATE SOURCE"); expect(text).not.toContain("capability=");
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(shell.headers.get(name)).toBe(value);
      expect((await fetch(`${host.origin}/browser/app.js`)).status).toBe(200);
      expect((await fetch(`${host.origin}/browser/unknown.js`)).status).toBe(404);
      expect((await fetch(`${host.origin}/`, { method: "OPTIONS" })).status).toBe(405);
      expect(shell.headers.get("access-control-allow-origin")).toBeNull();
    } finally { await host.close(); }
  });

  it("serves the exact canonical session plan.md, including a leading BOM, through the authenticated plan endpoint", async () => {
    const planRoot = await mkdtemp(join(tmpdir(), "pi-prompt-http-plan-")); const markdown = "\uFEFF# Saved plan\n\n## Execution\nNormal\n";
    await mkdir(join(planRoot, "session"), { recursive: true });
    await writeFile(join(planRoot, "session", "plan.md"), markdown, { mode: 0o600 });
    const fake = fakeController(readyState({ committedMarkdown: markdown }));
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn(), planRoot });
    try {
      expect((await fetch(`${host.origin}/api/v1/plan`)).status).toBe(401);
      const response = await fetch(`${host.origin}/api/v1/plan`, { headers: auth(host) });
      expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/markdown"); expect(response.headers.get("etag")).toBe('"pi-plan-state-3"');
      const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await response.arrayBuffer());
      expect(decoded).toBe(markdown); expect(decoded.codePointAt(0)).toBe(0xfeff);
    } finally { await host.close(); }
  });

  it("requires exact host/auth/custom origin and mutation Origin, and returns generic secured errors", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      for (const response of [
        await fetch(`${host.origin}/api/v1/snapshot`),
        await fetch(`${host.origin}/api/v1/snapshot`, { headers: { ...auth(host), Authorization: "Bearer wrong" } }),
        await fetch(`${host.origin}/api/v1/snapshot`, { headers: { ...auth(host), "X-Pi-Prompt-Origin": "http://evil.invalid" } }),
        await fetch(`${host.origin}/api/v1/snapshot`, { headers: { ...auth(host), Origin: "http://evil.invalid" } }),
      ]) { expect([401, 403]).toContain(response.status); expect(response.headers.get("content-security-policy")).toBe(SECURITY_HEADERS["Content-Security-Policy"]); expect(JSON.stringify(await json(response))).not.toContain("PRIVATE"); }
      const noOrigin = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: { ...auth(host, false), "Content-Type": "application/json", "If-Match": '"pi-plan-state-3"' }, body: JSON.stringify({ requestId: "request-id-00000001", target: { kind: "element", elementId: "step" }, body: "x" }) });
      expect(noOrigin.status).toBe(403);
    } finally { await host.close(); }
  });

  it("configures a private writer endpoint before returning and never exposes its URL or bearer publicly", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      expect(fake.raw.configureWriterEndpoint).toHaveBeenCalledWith(`${host.origin}/api/v1/writer-results`);
      expect(host).not.toHaveProperty("writerEndpoint"); expect(host.launchUrl).not.toContain("writer-results");
      const snapshot = await json(await fetch(`${host.origin}/api/v1/snapshot`, { headers: auth(host) }));
      expect(JSON.stringify(snapshot)).not.toContain("writer-results"); expect(JSON.stringify(snapshot)).not.toContain("attempt_identity");
    } finally { await host.close(); }
  });

  it("accepts exact writer bytes without Origin and rejects browser, wrong, duplicate, malformed, and unsupported submissions", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    const path = `${host.origin}/api/v1/writer-results`;
    try {
      const browserToken = new URL(host.launchUrl).hash.slice("#capability=".length);
      const wrongHost = await new Promise<string>((resolve, reject) => {
        const socket = connect(host.port, "127.0.0.1"); let raw = ""; socket.setEncoding("utf8"); socket.once("error", reject);
        socket.on("data", (chunk) => { raw += chunk; }); socket.once("end", () => resolve(raw));
        socket.once("connect", () => socket.write(["POST /api/v1/writer-results HTTP/1.1", "Host: evil.invalid", "Authorization: Bearer attempt_identity_0001", "Content-Type: text/markdown", "X-Pi-Prompt-Result: plan", "Content-Length: 1", "Connection: close", "", "x"].join("\r\n")));
      });
      expect(wrongHost).toContain("HTTP/1.1 400 Bad Request");
      expect((await fetch(path, { method: "POST", headers: writerHeaders(browserToken, "plan"), body: "# Browser" })).status).toBe(401);
      expect((await fetch(path, { method: "POST", headers: writerHeaders("attempt_identity_wrong", "plan"), body: "# Wrong" })).status).toBe(401);
      expect((await fetch(path, { method: "GET", headers: { Authorization: "Bearer attempt_identity_0001" } })).status).toBe(405);
      expect((await fetch(path, { method: "POST", headers: { ...writerHeaders("attempt_identity_0001", "plan"), "X-Pi-Prompt-Result": "unknown" }, body: "x" })).status).toBe(422);
      const wrongType = await fetch(path, { method: "POST", headers: writerHeaders("attempt_identity_0001", "plan", "application/json"), body: "PRIVATE BODY MUST NOT ECHO" });
      expect(wrongType.status).toBe(415); expect(JSON.stringify(await json(wrongType))).not.toContain("PRIVATE BODY");
      expect((await fetch(path, { method: "POST", headers: writerHeaders("attempt_identity_0001", "clarification"), body: "{" })).status).toBe(422);

      const exact = Buffer.from("# Exact\r\n\r\n## Execution\r\nNormal\r\n", "utf8");
      const accepted = await fetch(path, { method: "POST", headers: writerHeaders("attempt_identity_0001", "plan"), body: exact });
      expect(accepted.status).toBe(202); expect(fake.writerSubmissions).toHaveLength(1); expect(fake.writerSubmissions[0]!.body.equals(exact)).toBe(true);
      expect((await fetch(path, { method: "POST", headers: writerHeaders("attempt_identity_0001", "plan"), body: exact })).status).toBe(401);
    } finally { await host.close(); }
  });

  it("accepts a strict clarification body and rejects over-limit streaming declarations", async () => {
    const clarification = fakeController(); const host = await startPlanHttpHost({ controller: clarification.controller, reopenInPi: vi.fn() });
    try {
      const body = Buffer.from(JSON.stringify({ questions: [{ id: "q", prompt: "Choose?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }] }));
      const response = await fetch(`${host.origin}/api/v1/writer-results`, { method: "POST", headers: writerHeaders("attempt_identity_0001", "clarification"), body });
      expect(response.status).toBe(202); expect(clarification.writerSubmissions[0]).toMatchObject({ kind: "clarification" });
    } finally { await host.close(); }
    const oversized = fakeController(); const oversizedHost = await startPlanHttpHost({ controller: oversized.controller, reopenInPi: vi.fn() });
    try {
      const response = await fetch(`${oversizedHost.origin}/api/v1/writer-results`, { method: "POST", headers: writerHeaders("attempt_identity_0001", "clarification"), body: Buffer.alloc(64 * 1024 + 1, 0x61) });
      expect(response.status).toBe(413); expect(oversized.raw.submitWriterResult).not.toHaveBeenCalled();
    } finally { await oversizedHost.close(); }
  });

  it("adds the normal security headers to raw parser errors", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = connect(host.port, "127.0.0.1"); let response = "";
        socket.setEncoding("utf8"); socket.once("error", reject); socket.on("data", (chunk) => { response += chunk; }); socket.once("end", () => resolve(response));
        socket.once("connect", () => socket.write("INVALID REQUEST\r\n\r\n"));
      });
      expect(raw).toContain("HTTP/1.1 400 Bad Request");
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(raw).toContain(`${name}: ${value}`);
    } finally { await host.close(); }
  });

  it("enforces method, precondition, content type/size, fatal UTF-8, duplicate keys, and exact schemas", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      expect((await fetch(`${host.origin}/api/v1/snapshot`, { method: "POST", headers: auth(host, true), body: "{}" })).status).toBe(405);
      const missing = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true), body: "{}" }); expect(missing.status).toBe(428);
      const wrongType = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: { ...auth(host, true, '"pi-plan-state-3"'), "Content-Type": "text/plain" }, body: "{}" }); expect(wrongType.status).toBe(415);
      const duplicate = '{"requestId":"request-id-00000001","body":"a","body":"b","target":{"kind":"element","elementId":"step"}}';
      const duplicateResponse = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: duplicate }); expect(duplicateResponse.status).toBe(400); expect(await json(duplicateResponse)).toMatchObject({ error: { code: "duplicate-key" } });
      const invalidUtf8 = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: new Uint8Array([0xff]) }); expect(invalidUtf8.status).toBe(400); expect(await json(invalidUtf8)).toMatchObject({ error: { code: "invalid-utf8" } });
      const extra = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-00000001", target: { kind: "element", elementId: "step" }, body: "x", path: "/private" }) }); expect(extra.status).toBe(422);
      const huge = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-00000001", target: { kind: "element", elementId: "step" }, body: "x".repeat(256 * 1024) }) }); expect(huge.status).toBe(413);
    } finally { await host.close(); }
  });

  it("runs annotation/update/revision endpoints with ETags, stale conflicts, replay, and durable events", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn(), longPollMs: 20 });
    try {
      const snapshotResponse = await fetch(`${host.origin}/api/v1/snapshot`, { headers: auth(host) });
      expect(snapshotResponse.headers.get("etag")).toBe('"pi-plan-state-3"'); const snapshot = await json(snapshotResponse); expect(snapshot.snapshot.promptPreview).toBe("PRIVATE SOURCE"); expect(JSON.stringify(snapshot)).not.toContain("/private/SKILL.md");
      const createBody = { requestId: "request-id-00000001", target: { kind: "element", elementId: "step" }, body: "literal <script>x</script>" };
      const [first, duplicate] = await Promise.all([1, 2].map(() => fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify(createBody) })));
      expect(first.status).toBe(200); expect(duplicate.status).toBe(200); expect(fake.raw.addAnnotation).toHaveBeenCalledTimes(1);
      const created = await json(first); expect(created.snapshot.annotations[0].body).toBe("literal <script>x</script>");
      const mismatch = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ ...createBody, body: "different" }) }); expect(mismatch.status).toBe(409);
      const stale = await fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ ...createBody, requestId: "request-id-00000002" }) }); expect(stale.status).toBe(409); expect(await json(stale)).toMatchObject({ current: { stateVersion: 4 } });
      const patch = await fetch(`${host.origin}/api/v1/annotations/note-1`, { method: "PATCH", headers: auth(host, true, '"pi-plan-state-4"'), body: JSON.stringify({ requestId: "request-id-00000003", update: { body: "updated" } }) }); expect(patch.status).toBe(200);
      const revision = await fetch(`${host.origin}/api/v1/revision-requests`, { method: "POST", headers: auth(host, true, '"pi-plan-state-5"'), body: JSON.stringify({ requestId: "request-id-00000004", selectedAnnotationIds: ["note-1"], instruction: "Revise" }) }); expect(revision.status).toBe(202); expect(await json(revision)).toMatchObject({ job: { status: "revising" }, snapshot: { stateVersion: 6 } }); expect(fake.raw.dispatchGeneration).toHaveBeenCalledWith("job-1");
      const events = await fetch(`${host.origin}/api/v1/events?after=0`, { headers: auth(host) }); const eventBody = await json(events); expect(eventBody.events.map((event: any) => event.stateVersion)).toEqual([4, 5, 6]);
      expect(JSON.stringify(eventBody)).not.toContain("instruction");
      const future = await fetch(`${host.origin}/api/v1/events?after=999`, { headers: auth(host) }); expect(future.status).toBe(400);
    } finally { await host.close(); }
  });

  it("retries an invalid initial generation through a replay-safe browser mutation", async () => {
    const fake = fakeController(readyState({ status: "error", documentRevision: 0, document: null, lastError: { code: "invalid-generation-result", message: "The planner output could not be applied safely. Retry generation." } }));
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const before = await json(await fetch(`${host.origin}/api/v1/snapshot`, { headers: auth(host) }));
      expect(before.snapshot.actions).toMatchObject({ canRetryGeneration: true });
      const body = JSON.stringify({ requestId: "request-retry-generation-01" });
      const retry = await fetch(`${host.origin}/api/v1/generation-retries`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body });
      expect(retry.status).toBe(202);
      expect(await json(retry)).toMatchObject({ job: { status: "generating" }, snapshot: { status: "generating", stateVersion: 4, actions: { canRetryGeneration: false } } });
      expect(fake.raw.generate).toHaveBeenCalledWith({ expectedStateVersion: 3 });
      expect(fake.raw.dispatchGeneration).toHaveBeenCalledWith("job-1");
      const replay = await fetch(`${host.origin}/api/v1/generation-retries`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body });
      expect(replay.status).toBe(202); expect(fake.raw.generate).toHaveBeenCalledTimes(1);
    } finally { await host.close(); }
  });

  it("accepts clarification answers once with replay-safe 202 and returns 409/422 without consuming stale input", async () => {
    const question = { id: "question", prompt: "Choose?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    const pending = { id: "round", operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: [], questions: [question] };
    const fake = fakeController(readyState({ status: "awaiting-clarification", clarifications: { history: [], origin: { operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [] }, pending } }));
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const body = { requestId: "request-id-clarify-01", clarificationId: "round", answers: [{ questionId: "question", answer: { kind: "option", optionId: "a" } }] };
      const [first, replay] = await Promise.all([1, 2].map(() => fetch(`${host.origin}/api/v1/clarification-answers`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify(body) })));
      expect(first.status).toBe(202); expect(replay.status).toBe(202); expect(await json(replay)).toEqual(await json(first)); expect(fake.raw.answerClarification).toHaveBeenCalledTimes(1); expect(fake.raw.dispatchGeneration).toHaveBeenCalledTimes(1);
      const stale = fakeController(readyState({ status: "awaiting-clarification", clarifications: { history: [], origin: { operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [] }, pending } }));
      const staleHost = await startPlanHttpHost({ controller: stale.controller, reopenInPi: vi.fn() });
      try {
        const wrong = await fetch(`${staleHost.origin}/api/v1/clarification-answers`, { method: "POST", headers: auth(staleHost, true, '"pi-plan-state-3"'), body: JSON.stringify({ ...body, requestId: "request-id-clarify-02", clarificationId: "wrong" }) }); expect(wrong.status).toBe(409); expect(await json(wrong)).toHaveProperty("snapshot.clarification.id", "round");
        const blank = await fetch(`${staleHost.origin}/api/v1/clarification-answers`, { method: "POST", headers: auth(staleHost, true, '"pi-plan-state-3"'), body: JSON.stringify({ ...body, requestId: "request-id-clarify-03", answers: [{ questionId: "question", answer: { kind: "custom", text: " " } }] }) }); expect(blank.status).toBe(422); expect(stale.raw.answerClarification).not.toHaveBeenCalled(); expect(JSON.stringify(await json(blank))).not.toContain("question");
      } finally { await staleHost.close(); }
    } finally { await host.close(); }
  });

  it("returns safe conflicts for every annotation mutation while awaiting clarification", async () => {
    const question = { id: "question", prompt: "Choose?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] };
    const pending = { id: "round", operation: "revision" as const, baseDocumentRevision: 1, selectedAnnotationIds: [], questions: [question] };
    const note = { id: "note-1", target: { kind: "element" as const, elementId: "step" }, targetSnapshot: { documentRevision: 1, target: { kind: "element" as const, elementId: "step" }, elementKind: "step" as const, text: "Do it" }, body: "Visible", status: "open" as const, history: [], createdAgainstRevision: 1, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" };
    const fake = fakeController(readyState({ status: "awaiting-clarification", annotations: [note], clarifications: { history: [], origin: { operation: "revision", baseDocumentRevision: 1, selectedAnnotationIds: [] }, pending } }));
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const requests = [
        fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-readonly-create", target: { kind: "element", elementId: "step" }, body: "Blocked" }) }),
        fetch(`${host.origin}/api/v1/annotations/note-1`, { method: "PATCH", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-readonly-update", update: { body: "Blocked" } }) }),
        fetch(`${host.origin}/api/v1/annotations/note-1`, { method: "PATCH", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-readonly-status", update: { status: "dismissed" } }) }),
      ];
      for (const response of await Promise.all(requests)) { expect(response.status).toBe(409); expect(await json(response)).toMatchObject({ error: { code: "clarification-read-only" } }); }
      expect(fake.getState().annotations).toEqual([note]);
    } finally { await host.close(); }
  });

  it("accepts/stages once before response close and handles pause, cancel, and reopen on isolated hosts", async () => {
    const accepted = fakeController(); const acceptHost = await startPlanHttpHost({ controller: accepted.controller, reopenInPi: vi.fn() });
    const accept = await fetch(`${acceptHost.origin}/api/v1/accept`, { method: "POST", headers: auth(acceptHost, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-accept-01", stateVersion: 3, documentRevision: 1, confirmed: true }) });
    expect(accept.status).toBe(200); expect(accepted.raw.accept).toHaveBeenCalledTimes(1); await acceptHost.close(); expect(acceptHost.closed).toBe(true);

    for (const disposition of ["pause", "cancel"] as const) {
      const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
      const response = await fetch(`${host.origin}/api/v1/cancel`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: `request-id-${disposition}-0001`, disposition }) });
      expect(response.status).toBe(200); expect(disposition === "pause" ? fake.raw.pause : fake.raw.cancel).toHaveBeenCalledTimes(1); await host.close();
    }

    const reopen = vi.fn(); const reopening = fakeController(); const reopenHost = await startPlanHttpHost({ controller: reopening.controller, reopenInPi: reopen });
    const response = await fetch(`${reopenHost.origin}/api/v1/reopen-in-pi`, { method: "POST", headers: auth(reopenHost, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-reopen-001" }) });
    expect(response.status).toBe(200); await reopenHost.close(); await Promise.resolve(); expect(reopen).toHaveBeenCalledTimes(1); expect(reopening.raw.accept).not.toHaveBeenCalled();
  });

  it("closes and reopens exactly once when a raw client aborts its accepted terminal response", async () => {
    const fake = fakeController();
    let reopened!: () => void;
    const reopenedOnce = new Promise<void>((resolve) => { reopened = resolve; });
    const reopen = vi.fn(() => { reopened(); });
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: reopen });
    const token = new URL(host.launchUrl).hash.slice("#capability=".length);
    const body = JSON.stringify({ requestId: "request-id-aborted-reopen" });
    await new Promise<void>((resolve, reject) => {
      const socket = connect(host.port, "127.0.0.1");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.write([
          "POST /api/v1/reopen-in-pi HTTP/1.1", `Host: 127.0.0.1:${host.port}`,
          `Authorization: Bearer ${token}`, `X-Pi-Prompt-Origin: ${host.origin}`, `Origin: ${host.origin}`,
          "Content-Type: application/json", 'If-Match: "pi-plan-state-3"', `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: keep-alive", "", body,
        ].join("\r\n"), () => { socket.destroy(); resolve(); });
      });
    });
    await Promise.race([reopenedOnce, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("reopen-timeout")), 1_000))]);
    await host.close();
    expect(host.closed).toBe(true);
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("keeps a stage-failed accepted snapshot open and retries exact accepted versions", async () => {
    const fake = fakeController(readyState(), { stageFailures: 1 });
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    try {
      const failed = await fetch(`${host.origin}/api/v1/accept`, { method: "POST", headers: auth(host, true, '"pi-plan-state-3"'), body: JSON.stringify({ requestId: "request-id-stagefail-1", stateVersion: 3, documentRevision: 1, confirmed: true }) });
      expect(failed.status).toBe(503);
      expect(failed.headers.get("etag")).toBe('"pi-plan-state-4"');
      expect(await json(failed)).toMatchObject({ error: { code: "stage-failed" }, accepted: true, snapshot: { status: "accepted", stateVersion: 4, documentRevision: 1, actions: { canRetryStaging: true } } });
      expect(host.closed).toBe(false);
      const retried = await fetch(`${host.origin}/api/v1/accept`, { method: "POST", headers: auth(host, true, '"pi-plan-state-4"'), body: JSON.stringify({ requestId: "request-id-stageretry-1", stateVersion: 4, documentRevision: 1, confirmed: true }) });
      expect(retried.status).toBe(200); expect(fake.raw.accept).toHaveBeenCalledTimes(2);
    } finally { await host.close(); }
  });

  it.each(["pause", "accept"] as const)("sets close intent inside the serialized %s mutation and rejects queued work while sharing duplicates", async (terminal) => {
    const fake = fakeController();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    if (terminal === "pause") fake.raw.pause.mockImplementationOnce(async () => { entered(); await blocked; return { ok: true, value: undefined }; });
    else fake.raw.accept.mockImplementationOnce(async () => { entered(); await blocked; return { ok: true, value: undefined }; });
    const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn() });
    const requestId = `request-id-race-${terminal}`;
    const path = terminal === "pause" ? "/api/v1/cancel" : "/api/v1/accept";
    const body = terminal === "pause" ? { requestId, disposition: "pause" } : { requestId, stateVersion: 3, documentRevision: 1, confirmed: true };
    const mutationHeaders = { ...auth(host, true, '"pi-plan-state-3"'), Connection: "close" };
    const first = fetch(`${host.origin}${path}`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) });
    await started;
    const duplicate = fetch(`${host.origin}${path}`, { method: "POST", headers: mutationHeaders, body: JSON.stringify(body) });
    const queued = fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ requestId: `request-id-queued-${terminal}`, target: { kind: "element", elementId: "step" }, body: "queued" }) });
    const probe = await fetch(`${host.origin}/api/v1/snapshot`, { headers: { ...auth(host), Connection: "close" } });
    expect(probe.status).toBe(200);
    release();
    const [firstResponse, duplicateResponse, queuedResponse] = await Promise.all([first, duplicate, queued]);
    expect(firstResponse.status).toBe(200); expect(duplicateResponse.status).toBe(200);
    expect(await json(duplicateResponse)).toEqual(await json(firstResponse));
    expect(queuedResponse.status).toBe(503); expect(await json(queuedResponse)).toMatchObject({ error: { code: "closing" } });
    expect(fake.raw.addAnnotation).not.toHaveBeenCalled();
    await host.close(); expect(host.closed).toBe(true);
  });

  it("serializes reopen close intent ahead of a queued accept while sharing the duplicate reopen response", async () => {
    const fake = fakeController();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fake.raw.addAnnotation.mockImplementationOnce(async () => { entered(); await blocked; return { ok: true, value: undefined }; });
    const reopen = vi.fn(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: reopen });
    const headers = { ...auth(host, true, '"pi-plan-state-3"'), Connection: "close" };
    const blocker = fetch(`${host.origin}/api/v1/annotations`, { method: "POST", headers, body: JSON.stringify({ requestId: "request-id-block-reopen", target: { kind: "element", elementId: "step" }, body: "block" }) });
    await started;
    const token = new URL(host.launchUrl).hash.slice("#capability=".length);
    const rawRequest = (path: string, body: object): string => {
      const encoded = JSON.stringify(body);
      return [`POST ${path} HTTP/1.1`, `Host: 127.0.0.1:${host.port}`, `Authorization: Bearer ${token}`, `X-Pi-Prompt-Origin: ${host.origin}`, `Origin: ${host.origin}`, "Content-Type: application/json", 'If-Match: "pi-plan-state-3"', `Content-Length: ${Buffer.byteLength(encoded)}`, "Connection: keep-alive", "", encoded].join("\r\n");
    };
    const reopenBody = { requestId: "request-id-reopen-race" };
    const pipeline = new Promise<string>((resolve, reject) => {
      const socket = connect(host.port, "127.0.0.1"); let response = "";
      socket.setEncoding("utf8"); socket.once("error", reject); socket.on("data", (chunk) => { response += chunk; }); socket.once("end", () => resolve(response));
      socket.once("connect", () => socket.write([
        rawRequest("/api/v1/reopen-in-pi", reopenBody),
        rawRequest("/api/v1/reopen-in-pi", reopenBody),
        rawRequest("/api/v1/accept", { requestId: "request-id-accept-queued", stateVersion: 3, documentRevision: 1, confirmed: true }),
      ].join("")));
    });
    expect((await fetch(`${host.origin}/api/v1/snapshot`, { headers: { ...auth(host), Connection: "close" } })).status).toBe(200);
    release();
    expect((await blocker).status).toBe(200);
    const raw = await pipeline;
    expect(raw.match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2); expect(raw.match(/"reopening":true/g)).toHaveLength(2);
    expect(raw).toContain("HTTP/1.1 503 Service Unavailable"); expect(raw).toContain('"code":"closing"'); expect(fake.raw.accept).not.toHaveBeenCalled();
    await host.close(); await Promise.resolve(); expect(reopen).toHaveBeenCalledTimes(1);
  });

  it("charges only authenticated API requests against the request budget", async () => {
    const fake = fakeController(); const host = await startPlanHttpHost({ controller: fake.controller, reopenInPi: vi.fn(), maximumRequestsPerMinute: 1 });
    try {
      expect((await fetch(`${host.origin}/browser/app.js`)).status).toBe(200);
      expect((await fetch(`${host.origin}/browser/app.js`)).status).toBe(200);
      expect((await fetch(`${host.origin}/api/v1/snapshot`)).status).toBe(401);
      expect((await fetch(`${host.origin}/api/v1/snapshot`, { headers: auth(host) })).status).toBe(200);
      expect((await fetch(`${host.origin}/api/v1/snapshot`, { headers: auth(host) })).status).toBe(429);
    } finally { await host.close(); }
  });

  it("bounds long polls/rates/idle lifecycle and rotates capabilities", async () => {
    const first = fakeController(); const host1 = await startPlanHttpHost({ controller: first.controller, reopenInPi: vi.fn(), longPollMs: 10, maximumRequestsPerMinute: 2 });
    const second = fakeController(); const host2 = await startPlanHttpHost({ controller: second.controller, reopenInPi: vi.fn(), idleMs: 100 });
    try {
      expect(new URL(host1.launchUrl).hash).not.toBe(new URL(host2.launchUrl).hash);
      const started = Date.now(); const poll = await fetch(`${host1.origin}/api/v1/events?after=0`, { headers: auth(host1) }); expect(poll.status).toBe(200); expect(Date.now() - started).toBeLessThan(500);
      await fetch(`${host1.origin}/api/v1/snapshot`, { headers: auth(host1) });
      const limited = await fetch(`${host1.origin}/api/v1/snapshot`, { headers: auth(host1) }); expect(limited.status).toBe(429);
      await new Promise((resolve) => setTimeout(resolve, 140));
      expect(host2.closed).toBe(true); expect(second.listeners.size).toBe(0);
    } finally { await host1.close(); await host2.close(); }
  });
});
