import { describe, expect, it } from "vitest";
import { mutationFingerprint, parseMutation, parseStateIfMatch, stateEtag, toPublicSnapshot } from "../plan/protocol.js";
import type { PlanSession } from "../plan/types.js";

const privateState: PlanSession = {
  schemaVersion: 1, id: "session", stateVersion: 9, documentRevision: 2, status: "revising",
  source: { prompt: "SECRET PROMPT", cwd: "/private/cwd", skills: [{ name: "secret", path: "/private/SKILL.md", baseDir: "/private", sha256: "d".repeat(64) }] },
  execution: { kind: "goal" }, generation: { mode: "careful" },
  generationJob: { jobId: "opaque-public-job", operation: "revision", baseDocumentRevision: 2, selectedAnnotationIds: ["note"], instruction: "PRIVATE INSTRUCTION", startedAt: "2026-07-10T00:00:00.000Z" },
  document: { id: "document", title: { id: "title", kind: "title", body: "<img src=x onerror=alert(1)>", children: [] }, elements: [{ id: "execution", kind: "execution", body: "/goal (read only)", children: [] }] },
  annotations: [{ id: "note", target: { kind: "element", elementId: "execution" }, targetSnapshot: { documentRevision: 2, target: { kind: "element", elementId: "execution" }, elementKind: "execution", text: "/goal (read only)" }, body: "literal <script>hostile()</script>", status: "open", history: [], createdAgainstRevision: 2, createdAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:00:00.000Z" }],
};

describe("browser protocol", () => {
  it("projects an explicit public allowlist and preserves hostile text as data", () => {
    const snapshot = toPublicSnapshot(privateState, {}, {
      phase: "waiting-report", headline: "Waiting for the primary report", summary: "One primary planner is working independently.",
      startedAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:01:00.000Z", budgetMinutes: 10, overBudget: true,
      adapter: "delegated", model: { slot: "reading-default", model: "provider/planner", thinking: "high" }, primary: { count: 1, status: "waiting" }, helpers: { supported: false, active: 0 },
      progress: { summary: `  ${"p".repeat(130)}\nPRIVATE TRAILING  `, updatedAt: "2026-07-10T00:00:30.000Z", model: "PRIVATE MODEL", teamName: "PRIVATE TEAM" },
      timeline: [{ phase: "capability-detected", at: "2026-07-10T00:00:00.000Z" }, { phase: "waiting-report", at: "2026-07-10T00:01:00.000Z" }],
      privateReport: "REPORT SECRET", toolName: "spawn_agent", nonce: "NONCE SECRET",
    } as never);
    expect(snapshot.id).toBe("session");
    expect(snapshot.document?.title.body).toBe("<img src=x onerror=alert(1)>");
    expect(snapshot.annotations[0]).toMatchObject({ author: "user", body: "literal <script>hostile()</script>", locked: true, targetSummary: { label: "Execution" } });
    expect(snapshot.job).toEqual({ id: "opaque-public-job", operation: "revision", baseDocumentRevision: 2, startedAt: "2026-07-10T00:00:00.000Z" });
    expect(Object.keys(snapshot.job!)).toEqual(["id", "operation", "baseDocumentRevision", "startedAt"]);
    expect(snapshot.originalPrompt).toBe(privateState.source.prompt);
    expect(snapshot.promptPreview).toBe(privateState.source.prompt);
    expect(snapshot.actions).toEqual({ canRetryGeneration: false, canRetryStaging: false });
    expect(snapshot.activity).toEqual({
      phase: "waiting-report", headline: "Waiting for the primary report", summary: "One primary planner is working independently.",
      startedAt: "2026-07-10T00:00:00.000Z", updatedAt: "2026-07-10T00:01:00.000Z", budgetMinutes: 10, overBudget: true,
      adapter: "delegated", model: { slot: "reading-default", model: "provider/planner", thinking: "high" }, primary: { count: 1, status: "waiting" }, helpers: { supported: false, active: 0 },
      progress: { summary: "p".repeat(120), updatedAt: "2026-07-10T00:00:30.000Z" },
      timeline: [{ phase: "capability-detected", at: "2026-07-10T00:00:00.000Z" }, { phase: "waiting-report", at: "2026-07-10T00:01:00.000Z" }],
    });
    const encoded = JSON.stringify(snapshot);
    for (const secret of ["/private/cwd", "/private/SKILL.md", "PRIVATE INSTRUCTION", "PRIVATE TRAILING", "PRIVATE MODEL", "PRIVATE TEAM", "selectedAnnotationIds", "jobId", "sha256", "baseDir", "digest", "token", "stack", "REPORT SECRET", "spawn_agent", "NONCE SECRET", "privateReport", "toolName", "teamName"]) expect(encoded).not.toContain(secret);
    expect(encoded).not.toContain("targetSnapshot");
  });

  it("derives bounded range and historical annotation context without exposing snapshots", () => {
    const annotation = privateState.annotations[0]!;
    const orphaned = {
      ...privateState,
      generationJob: undefined,
      status: "ready" as const,
      annotations: [{
        ...annotation,
        status: "orphaned" as const,
        target: { kind: "range" as const, elementId: "deleted-step", selector: { field: "body" as const, start: 0, end: 11, exact: "quoted text" } },
        targetSnapshot: { documentRevision: 1, target: { kind: "element" as const, elementId: "deleted-step" }, elementKind: "step" as const, text: "x".repeat(300) },
      }],
    };
    const snapshot = toPublicSnapshot(orphaned, { canRetryStaging: true });
    expect(snapshot.annotations[0]).toMatchObject({
      locked: false,
      targetSummary: { label: "Step", field: "body", quote: "quoted text", historical: { elementKind: "step" } },
    });
    expect(snapshot.annotations[0]?.targetSummary.historical?.excerpt).toHaveLength(160);
    expect(snapshot.actions.canRetryStaging).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("targetSnapshot");
  });

  it("projects only pending clarification questions and never private origin or answers", () => {
    const pending = { id: "round-public", operation: "revision" as const, baseDocumentRevision: 2, selectedAnnotationIds: ["note"], instruction: "PRIVATE REVISION INSTRUCTION", questions: [{ id: "question-public", prompt: "Choose?", options: [{ id: "choice-a", label: "A" }, { id: "choice-b", label: "B" }] }] };
    const state = { ...privateState, status: "awaiting-clarification" as const, generationJob: undefined, clarifications: { history: [{ id: "old-round", questions: pending.questions, answers: [{ questionId: "question-public", answer: { kind: "custom" as const, text: "PRIVATE ANSWER" } }], answeredAt: "2026-07-10T00:01:00.000Z" }], origin: { operation: "revision" as const, baseDocumentRevision: 2, selectedAnnotationIds: ["note"], instruction: "PRIVATE REVISION INSTRUCTION" }, pending } };
    const snapshot = toPublicSnapshot(state);
    expect(snapshot.clarification).toEqual({ id: "round-public", context: "revision", baseDocumentRevision: 2, questions: [{ id: "question-public", prompt: "Choose?", options: [{ id: "choice-a", label: "A" }, { id: "choice-b", label: "B" }] }] });
    const encoded = JSON.stringify(snapshot); for (const secret of ["PRIVATE ANSWER", "PRIVATE REVISION INSTRUCTION", "selectedAnnotationIds", "old-round"]) expect(encoded).not.toContain(secret);
  });

  it("uses one exact strong state ETag grammar", () => {
    expect(stateEtag(42)).toBe('"pi-plan-state-42"');
    expect(parseStateIfMatch('"pi-plan-state-42"')).toBe(42);
    for (const invalid of [undefined, "42", "W/\"pi-plan-state-42\"", '"pi-plan-state-01"', '"pi-plan-state-42", "other"']) expect(parseStateIfMatch(invalid)).toBeNull();
  });

  it("enforces exact mutation properties and user status restrictions", () => {
    const id = "request-id-00000001";
    expect(parseMutation("annotation-create", { requestId: id, target: { kind: "element", elementId: "execution" }, body: "note" }).ok).toBe(true);
    expect(parseMutation("annotation-create", { requestId: id, target: { kind: "element", elementId: "execution" }, body: "note", cwd: "/secret" }).ok).toBe(false);
    expect(parseMutation("annotation-patch", { requestId: id, update: { status: "addressed" } })).toMatchObject({ ok: false, code: "invalid-status" });
    expect(parseMutation("annotation-patch", { requestId: id, update: { status: "orphaned" } })).toMatchObject({ ok: false, code: "invalid-status" });
    expect(parseMutation("generation-retry", { requestId: id })).toEqual({ ok: true, value: { requestId: id } });
    expect(parseMutation("generation-retry", { requestId: id, prompt: "secret" }).ok).toBe(false);
    expect(parseMutation("grill", { requestId: id })).toEqual({ ok: true, value: { requestId: id } });
    expect(parseMutation("grill", { requestId: id, instruction: "secret" }).ok).toBe(false);
    expect(parseMutation("accept", { requestId: id, stateVersion: 9, documentRevision: 2, confirmed: false }).ok).toBe(false);
    expect(parseMutation("clarification-answers", { requestId: id, clarificationId: "round", answers: [{ questionId: "q", answer: { kind: "option", optionId: "a" } }] }).ok).toBe(true);
    expect(parseMutation("clarification-answers", { requestId: id, clarificationId: "round", answers: [{ questionId: "q", answer: { kind: "custom", text: "   " } }] })).toMatchObject({ ok: false, code: "invalid-answers" });
    expect(parseMutation("clarification-answers", { requestId: id, clarificationId: "round", answers: [{ questionId: "q", answer: { kind: "option", optionId: "a" } }, { questionId: "q", answer: { kind: "option", optionId: "b" } }] })).toMatchObject({ ok: false, code: "invalid-answers" });
  });

  it("fingerprints canonical key order, route kind, and precondition", () => {
    const a = { requestId: "request-id-00000001", disposition: "pause" as const };
    expect(mutationFingerprint("cancel", 4, a)).toBe(mutationFingerprint("cancel", 4, { disposition: "pause", requestId: a.requestId }));
    expect(mutationFingerprint("cancel", 4, a)).not.toBe(mutationFingerprint("cancel", 5, a));
  });
});
