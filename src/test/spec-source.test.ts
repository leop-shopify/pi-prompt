import { describe, expect, it } from "vitest";
import { captureSpecSource, verifyFreshSpecSource } from "../spec/source.js";
import { validateSpecSourceReference } from "../spec/schema.js";
import type { PlanSession } from "../plan/types.js";

function plan(overrides: Partial<PlanSession> = {}): PlanSession { const base = { schemaVersion: 1, id: "plan-session", stateVersion: 4, documentRevision: 1, status: "ready", source: { prompt: "Build", cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" }, document: { id: "doc", title: { id: "title", kind: "title", body: "Plan", children: [] }, elements: [] }, committedMarkdown: "# Exact Plan\r\n", annotations: [], grill: { basedOnDocumentRevision: 1, annotationIds: {}, decisionTree: { nodes: [] }, generatedAt: "2026-07-12T00:00:00.000Z" } } as PlanSession; return { ...base, ...overrides } as PlanSession; }
describe("Spec source capture", () => {
  it("captures exact durable Plan, annotation, and Grill refs and rejects any stale component", () => {
    const captured = captureSpecSource(plan(), "/tmp/pi-prompt-plans/plan-session"); expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.value.reference).toMatchObject({ planMarkdownPath: "/tmp/pi-prompt-plans/plan-session/plan.md", annotationsPath: "/tmp/pi-prompt-plans/plan-session/annotations.json", grillPath: "/tmp/pi-prompt-plans/plan-session/grill.json", grillPointer: "#/decisionTree", planDocumentRevision: 1, grillBasedOnDocumentRevision: 1 });
    expect(validateSpecSourceReference(captured.value.reference).ok).toBe(true);
    expect(verifyFreshSpecSource(captured.value, plan(), "/tmp/pi-prompt-plans/plan-session").ok).toBe(true);
    expect(verifyFreshSpecSource(captured.value, plan({ annotations: [{ changed: true }] as never }), "/tmp/pi-prompt-plans/plan-session")).toMatchObject({ ok: false, issues: [{ code: "stale-spec-source" }] });
  });
  it("requires a ready exact committed Plan and current Grill", () => {
    expect(captureSpecSource(plan({ committedMarkdown: undefined }), "/tmp/x").ok).toBe(false);
    expect(captureSpecSource(plan({ grill: undefined }), "/tmp/x").ok).toBe(false);
  });
});
