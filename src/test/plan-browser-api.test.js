import { describe, expect, it, vi } from "vitest";
import { clearCapability, createPlanApi, readCapability } from "../plan/browser/api.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const location = (hash = "") => ({ hash, pathname: "/", search: "" });

describe("browser review capability", () => {
  it("survives refresh in the same port-scoped session storage", () => {
    const capability = "a".repeat(43);
    const session = storage();
    const history = { replaceState: vi.fn() };

    expect(readCapability(location(`#capability=${capability}`), history, session)).toBe(capability);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    expect(readCapability(location(), history, session)).toBe(capability);
  });

  it("does not cross into another port origin and clears when review ends", () => {
    const capability = "b".repeat(43);
    const firstPort = storage();
    const otherPort = storage();
    const history = { replaceState: vi.fn() };

    expect(readCapability(location(`#capability=${capability}`), history, firstPort)).toBe(capability);
    expect(readCapability(location(), history, otherPort)).toBeNull();
    clearCapability(firstPort);
    expect(readCapability(location(), history, firstPort)).toBeNull();
  });

  it("rejects malformed stored capabilities", () => {
    const session = storage();
    session.setItem("pi-prompt-review-capability", "not-a-capability");
    expect(readCapability(location(), { replaceState: vi.fn() }, session)).toBeNull();
  });

  it("preserves a leading BOM in exact Plan and Spec Markdown", async () => {
    globalThis.window = { location: { origin: "http://127.0.0.1:4567" } };
    const plan = "\uFEFF# Plan\nExact.\n"; const spec = "\uFEFF# Spec\nExact.\n";
    const markdownResponse = (body, etag) => new Response(new TextEncoder().encode(body), { status: 200, headers: { "Content-Type": "text/markdown; charset=utf-8", ETag: etag } });
    const fetchImpl = vi.fn().mockResolvedValueOnce(markdownResponse(plan, '"pi-plan-state-3"')).mockResolvedValueOnce(markdownResponse(spec, '"pi-spec-state-7"'));
    const api = createPlanApi("a".repeat(43), fetchImpl);
    expect(await api.plan()).toEqual({ markdown: plan, etag: '"pi-plan-state-3"', stateVersion: 3 }); expect(await api.specMarkdown()).toBe(spec);
  });

  it("decodes Markdown as fatal UTF-8 without changing HTTP failure handling", async () => {
    globalThis.window = { location: { origin: "http://127.0.0.1:4567" } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff]), { status: 200 }))
      .mockResolvedValueOnce(new Response("failure", { status: 500 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("failure", { status: 500 }));
    const api = createPlanApi("a".repeat(43), fetchImpl);
    await expect(api.plan()).rejects.toThrow(); expect(await api.plan()).toBeNull(); expect(await api.specMarkdown()).toBeNull(); await expect(api.specMarkdown()).rejects.toMatchObject({ kind: "spec" });
  });

  it("sends exact selected generated annotation IDs and an optional Grill instruction", async () => {
    globalThis.window = { location: { origin: "http://127.0.0.1:4567" } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot: { stateVersion: 10 } }), { status: 202, headers: { "Content-Type": "application/json", ETag: '"pi-plan-state-10"' } }));
    const api = createPlanApi("a".repeat(43), fetchImpl); api.setVersion(9);
    await api.mutate("/api/v1/revision-requests", "POST", { requestId: "request-id-grill-0001", selectedAnnotationIds: ["grill-b", "grill-a"], instruction: "Keep the fallback modest." });
    const [url, options] = fetchImpl.mock.calls[0]; expect(url).toBe("/api/v1/revision-requests"); expect(options.headers["If-Match"]).toBe('"pi-plan-state-9"');
    expect(JSON.parse(options.body)).toEqual({ requestId: "request-id-grill-0001", selectedAnnotationIds: ["grill-b", "grill-a"], instruction: "Keep the fallback modest." });
  });

  it("keeps independent strong ETags for Plan and Spec routes", async () => {
    globalThis.window = { location: { origin: "http://127.0.0.1:4567" } };
    const response = (body, etag) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json", ETag: etag } });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ snapshot: { stateVersion: 3 } }, '"pi-plan-state-3"'))
      .mockResolvedValueOnce(response({ snapshot: { stateVersion: 7 } }, '"pi-spec-state-7"'))
      .mockResolvedValueOnce(response({ snapshot: { stateVersion: 4 } }, '"pi-plan-state-4"'))
      .mockResolvedValueOnce(response({ snapshot: { stateVersion: 8 } }, '"pi-spec-state-8"'));
    const api = createPlanApi("a".repeat(43), fetchImpl); const plan = await api.snapshot(); const spec = await api.specSnapshot(); api.setVersion(plan.stateVersion); api.setSpecVersion(spec.stateVersion); await api.mutate("/api/v1/grill-runs", "POST", { requestId: "request-id-plan-0001" }); await api.specMutate("/api/v1/spec/generations", "POST", { requestId: "request-id-spec-0001" });
    expect(fetchImpl.mock.calls[2][1].headers["If-Match"]).toBe('"pi-plan-state-3"'); expect(fetchImpl.mock.calls[3][1].headers["If-Match"]).toBe('"pi-spec-state-7"');
  });

  it("reports a missing or malformed Plan state ETag as an incoherent Markdown version", async () => {
    globalThis.window = { location: { origin: "http://127.0.0.1:4567" } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("# Missing\n", { status: 200 }))
      .mockResolvedValueOnce(new Response("# Weak\n", { status: 200, headers: { ETag: 'W/"pi-plan-state-4"' } }));
    const api = createPlanApi("a".repeat(43), fetchImpl);
    expect(await api.plan()).toEqual({ markdown: "# Missing\n", etag: null, stateVersion: null });
    expect(await api.plan()).toEqual({ markdown: "# Weak\n", etag: 'W/"pi-plan-state-4"', stateVersion: null });
  });
});
