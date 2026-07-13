import { describe, expect, it } from "vitest";
import { createSpecRangeTarget, reconcileSpecRevision } from "../spec/reconciliation.js";
import type { SpecComment } from "../spec/types.js";
import { NOW } from "./spec-fixtures.js";

function comment(markdown: string, exact: string): SpecComment { const start = [...markdown].join("").indexOf(exact); const codeStart = [...markdown.slice(0, start)].length; const target = createSpecRangeTarget(markdown, 1, codeStart, codeStart + [...exact].length); if (!target.ok) throw new Error(); return { id: "comment", target: target.value, originalTarget: target.value, body: "Fix it", status: "open", history: [], createdAt: NOW, updatedAt: NOW }; }
describe("Spec selected-text reconciliation", () => {
  it("reanchors a unique Unicode selection and addresses it only with a successful changed revision", () => {
    const before = "# Spec\n\nAlpha 😀 omega.\n"; const note = comment(before, "😀"); const next = "# Spec\n\nIntro. Alpha 😀 omega.\n";
    const result = reconcileSpecRevision({ previousMarkdown: before, nextMarkdown: next, previousRevision: 1, comments: [note], selectedCommentIds: [note.id], addressedCommentIds: [note.id], now: NOW });
    expect(result).toMatchObject({ ok: true, value: [{ status: "addressed", target: { exact: "😀" } }] });
    expect(reconcileSpecRevision({ previousMarkdown: before, nextMarkdown: before, previousRevision: 1, comments: [note], selectedCommentIds: [note.id], addressedCommentIds: [note.id], now: NOW })).toMatchObject({ ok: false, error: { code: "no-op-revision" } });
  });
  it("orphans safely when immediate context is unresolved or ambiguous", () => {
    const before = "# Spec\n\nunique target tail\n"; const note = comment(before, "target");
    const result = reconcileSpecRevision({ previousMarkdown: before, nextMarkdown: "# Spec\n\ntarget\nother target\n", previousRevision: 1, comments: [note], selectedCommentIds: [], addressedCommentIds: [], now: NOW });
    expect(result).toMatchObject({ ok: true, value: [{ status: "orphaned", statusBeforeOrphan: "open" }] });
  });
});
