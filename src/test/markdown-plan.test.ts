import { describe, expect, it } from "vitest";
import { planOutcomeFromMarkdown } from "../plan/markdown-plan.js";
import type { PlanSession } from "../plan/types.js";

const session: PlanSession = {
  schemaVersion: 1,
  id: "session",
  stateVersion: 2,
  documentRevision: 0,
  status: "generating",
  source: { prompt: "Build it", cwd: "/repo", skills: [] },
  execution: { kind: "normal" },
  generation: { mode: "normal" },
  document: null,
  annotations: [],
  generationJob: { jobId: "job", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" },
};
const markdown = "# Plan\n\n## Execution\nNormal\n\n## Implementation Tasks\n\n### Build\nImplement it.\n";

describe("Markdown Plan parser", () => {
  it("accepts exactly one leading BOM structurally", () => {
    const parsed = planOutcomeFromMarkdown(`\uFEFF${markdown}`, "initial", session, []);

    expect(parsed).toMatchObject({ ok: true, value: { kind: "plan", document: { title: { body: "Plan" } } } });
  });

  it("does not treat two leading BOMs as a title prefix", () => {
    const parsed = planOutcomeFromMarkdown(`\uFEFF\uFEFF${markdown}`, "initial", session, []);

    expect(parsed).toMatchObject({ ok: false, issues: [{ code: "title-position" }] });
  });
});
