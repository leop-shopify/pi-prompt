import { describe, expect, it } from "vitest";
import { parseSpecIfMatch, parseSpecMutation, specStateEtag, toPublicSpecSnapshot } from "../spec/protocol.js";
import { session } from "./spec-fixtures.js";

describe("isolated Spec protocol", () => {
  const requestId = "request-id-spec-0001";
  it("uses independent strong ETags and strict mutation schemas", () => {
    expect(specStateEtag(7)).toBe('"pi-spec-state-7"'); expect(parseSpecIfMatch('"pi-spec-state-7"')).toBe(7); expect(parseSpecIfMatch('"pi-plan-state-7"')).toBeNull();
    expect(parseSpecMutation("comment-create", { requestId, start: 2, end: 3, body: "Note" }).ok).toBe(true);
    expect(parseSpecMutation("comment-create", { requestId, start: 2, end: 3, body: "Note", path: "/secret" }).ok).toBe(false);
    expect(parseSpecMutation("comment-status", { requestId, status: "addressed" })).toMatchObject({ ok: false, code: "invalid-status" });
    expect(parseSpecMutation("revision", { requestId, selectedCommentIds: [] }).ok).toBe(true);
    expect(parseSpecMutation("fresh-generation", { requestId }).ok).toBe(true);
    expect(parseSpecMutation("fresh-generation", { requestId, source: {} })).toMatchObject({ ok: false, code: "invalid-request" });
  });
  it("exposes an allowlisted snapshot and opaque job id without private generation input", () => {
    const base = session();
    const snapshot = toPublicSpecSnapshot(session({
      stateVersion: 3, status: "revising",
      generationJob: { jobId: "opaque-spec-job", operation: "revision", baseSpecRevision: 1, selectedCommentIds: ["private-comment"], source: base.source, instruction: "PRIVATE INSTRUCTION", startedAt: "2026-07-12T00:00:00.000Z" },
    }));
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({ protocolVersion: 1, planSessionId: "plan-session", specRevision: 1, markdown: "# Spec\n\nBuild 😀 safely.\n" });
    expect(snapshot.job).toEqual({ id: "opaque-spec-job", operation: "revision", baseSpecRevision: 1, startedAt: "2026-07-12T00:00:00.000Z" });
    expect(Object.keys(snapshot.job!)).toEqual(["id", "operation", "baseSpecRevision", "startedAt"]);
    expect(serialized).not.toContain("/tmp/"); expect(serialized).not.toContain("Sha256"); expect(serialized).not.toContain("PRIVATE INSTRUCTION"); expect(serialized).not.toContain("private-comment"); expect(serialized).not.toContain("jobId");
  });
});
