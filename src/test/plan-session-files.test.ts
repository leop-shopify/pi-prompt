import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planOutcomeFromMarkdown } from "../plan/markdown-plan.js";
import { reconcileRevision } from "../plan/reconcile.js";
import { annotationsFilePath, planFilePath, planSessionDirectory, readPlanFile } from "../plan/session-files.js";
import type { Annotation, PlanDocument, PlanSession } from "../plan/types.js";

const markdown = `# Build the feature\n\n## Execution\nNormal\n\n## Implementation Tasks\nImplement in test-first order.\n\n### Add behavior\nScope: src/a.ts\nTest first: Add a failing test.\nImplement: Add the behavior.\nVerify: Run the focused test.\nDone when: The test passes.\n`;
const session = {
  schemaVersion: 1, id: "session-safe", stateVersion: 2, documentRevision: 0, status: "generating",
  source: { prompt: "Build it", cwd: "/repo", skills: [] }, execution: { kind: "normal" }, generation: { mode: "normal" },
  document: null, annotations: [], generationJob: { jobId: "job", operation: "initial", baseDocumentRevision: 0, selectedAnnotationIds: [], startedAt: "2026-07-11T00:00:00.000Z" },
} as PlanSession;

function previousDocument(): PlanDocument {
  return {
    id: "document", title: { id: "title", kind: "title", body: "Build the feature", children: [] },
    elements: [
      { id: "execution", kind: "execution", body: "Normal", children: [] },
      { id: "architecture", kind: "milestone", title: "Architecture", body: "Preserve the architecture.", children: [] },
      { id: "tasks", kind: "milestone", title: "Implementation Tasks", body: "Implement in test-first order.", children: [
        { id: "task", kind: "step", title: "Add behavior", body: "Scope: src/a.ts\nTest first: Add a failing test.\nImplement: Add the behavior.\nVerify: Run the focused test.\nDone when: The test passes.", children: [] },
      ] },
    ],
  };
}

describe("file-backed plan sessions", () => {
  it("keeps plan.md and annotations.json in one safe session directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-prompt-plans-"));
    const directory = planSessionDirectory(root, session.id);
    expect(planFilePath(root, session.id)).toBe(join(directory, "plan.md"));
    expect(annotationsFilePath(root, session.id)).toBe(join(directory, "annotations.json"));
    await mkdir(directory, { recursive: true });
    await writeFile(planFilePath(root, session.id), markdown, { mode: 0o600 });
    expect(await readPlanFile(root, session.id)).toBe(markdown);
    expect(() => planSessionDirectory(root, "../escape")).toThrow("unsafe-session-id");
  });

  it("materializes the saved Markdown plan and rejects files without one execution section", () => {
    const parsed = planOutcomeFromMarkdown(markdown, "initial", session, []);
    expect(parsed).toMatchObject({ ok: true, value: { kind: "plan", document: { title: { body: "Build the feature" } } } });
    expect(planOutcomeFromMarkdown("# Broken\n\n## Implementation Tasks\nTasks\n\n### Task\nScope: a\nTest first: b\nImplement: c\nVerify: d\nDone when: e\n", "initial", session, [])).toMatchObject({ ok: false, issues: [{ code: "execution-section" }] });
  });

  it("requires exactly one leading H1 for initial and revision files", () => {
    expect(planOutcomeFromMarkdown(`intro\n${markdown}`, "initial", session, [])).toMatchObject({ ok: false, issues: [{ code: "title-position" }] });
    expect(planOutcomeFromMarkdown(`${markdown}\n# Duplicate\n`, "initial", session, [])).toMatchObject({ ok: false, issues: [{ code: "duplicate-title" }] });
    const materialized = { ...session, documentRevision: 1, document: previousDocument(), annotations: [], status: "revising" } as PlanSession;
    expect(planOutcomeFromMarkdown(`${markdown}\n# Duplicate\n`, "revision", materialized, [])).toMatchObject({ ok: false, issues: [{ code: "duplicate-title" }] });
  });

  it("retains renamed H2/H3 identities so selected range notes remain attached and become addressed", () => {
    const document = previousDocument();
    const body = document.elements[2]!.children[0]!.body;
    const exact = "Add the behavior."; const start = body.indexOf(exact);
    const annotation: Annotation = {
      id: "note-1", target: { kind: "range", elementId: "task", selector: { field: "body", start, end: start + exact.length, exact } },
      targetSnapshot: { documentRevision: 1, target: { kind: "range", elementId: "task", selector: { field: "body", start, end: start + exact.length, exact } }, elementKind: "step", text: body },
      body: "Rename headings without losing this note", status: "open", history: [], createdAgainstRevision: 1,
      createdAt: "2026-07-11T00:00:00.000Z", updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const materialized = { ...session, documentRevision: 1, document, annotations: [annotation], status: "revising" } as PlanSession;
    const revisionBase = markdown.replace("## Implementation Tasks", "## Architecture\nPreserve the architecture.\n\n## Implementation Tasks");
    const revisedMarkdown = revisionBase.replace("## Architecture", "## Technical Approach").replace("### Add behavior", "### Implement behavior");
    const parsed = planOutcomeFromMarkdown(revisedMarkdown, "revision", materialized, [annotation.id]);
    expect(parsed.ok).toBe(true); if (!parsed.ok || parsed.value.kind !== "revision") return;
    expect(parsed.value.document.elements[1]).toMatchObject({ retainedId: "architecture", title: "Technical Approach" });
    expect(parsed.value.document.elements[2]?.children[0]).toMatchObject({ retainedId: "task", title: "Implement behavior" });
    const reconciled = reconcileRevision({ previousDocument: document, previousRevision: 1, annotations: [annotation], result: parsed.value, selectedAnnotationIds: [annotation.id], idFactory: () => "new-id", now: "2026-07-11T01:00:00.000Z" });
    expect(reconciled).toMatchObject({ ok: true, value: { document: { elements: [{ id: "execution" }, { id: "architecture", title: "Technical Approach" }, { id: "tasks", children: [{ id: "task", title: "Implement behavior" }] }] }, annotations: [{ id: "note-1", status: "addressed", target: { elementId: "task" } }] } });
  });
});
