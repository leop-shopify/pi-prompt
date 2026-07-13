import { describe, expect, it } from "vitest";
import { createSpecRangeTarget } from "../spec/reconciliation.js";
import { sha256Text, validateSpecMarkdown, validateSpecSession, validateSpecSourceReference, validateSpecTarget } from "../spec/schema.js";
import { MARKDOWN, NOW, session } from "./spec-fixtures.js";

describe("strict Spec schema", () => {
  it("accepts exact UTF-8 Markdown with any H1 and does not parse Plan structure", () => {
    expect(validateSpecMarkdown("intro\n# Product specification\n\n## API\nBody 😀\n").ok).toBe(true);
    const bom = "\uFEFF# Product specification\n"; const preserved = validateSpecMarkdown(bom);
    expect(preserved).toEqual({ ok: true, value: bom });
    expect(validateSpecMarkdown(`\uFEFF${bom}`)).toMatchObject({ ok: false, issues: [{ code: "missing-h1" }] });
    expect(validateSpecMarkdown("## Missing H1\n")).toMatchObject({ ok: false, issues: [{ code: "missing-h1" }] });
    expect(validateSpecMarkdown("# Spec\0bad").ok).toBe(false);
  });
  it("binds persisted source paths to normalized Plan artifact children", () => {
    const valid = session().source;
    expect(validateSpecSourceReference(valid).ok).toBe(true);
    for (const source of [
      { ...valid, planArtifactPath: "/tmp/pi-prompt-plans/plan-session/..//plan-session" },
      { ...valid, planMarkdownPath: "/tmp/pi-prompt-plans/sibling/plan.md" },
      { ...valid, annotationsPath: "/tmp/pi-prompt-plans/plan-session/nested/../annotations.json" },
      { ...valid, grillPath: "/tmp/pi-prompt-plans/plan-session/../grill.json" },
      { ...valid, grillPointer: "#/other" },
    ]) expect(validateSpecSourceReference(source).ok).toBe(false);
    expect(validateSpecSession({ ...session(), source: { ...valid, planMarkdownPath: "/tmp/other/plan.md" } }).ok).toBe(false);
  });
  it("validates Unicode code-point ranges with exact immediate context and snapshot hash", () => {
    const start = [...MARKDOWN].indexOf("😀"); const target = createSpecRangeTarget(MARKDOWN, 1, start, start + 1); expect(target.ok).toBe(true); if (!target.ok) return;
    expect(target.value.exact).toBe("😀"); expect(validateSpecTarget(target.value, MARKDOWN, 1, sha256Text(MARKDOWN))).toBe(true);
    expect(validateSpecTarget({ ...target.value, start: target.value.start + 1 }, MARKDOWN, 1)).toBe(false);
    const comment = { id: "comment", target: target.value, originalTarget: target.value, body: "Clarify emoji.", status: "open" as const, history: [], createdAt: NOW, updatedAt: NOW };
    expect(validateSpecSession(session({ comments: [comment] })).ok).toBe(true);
    expect(validateSpecSession({ ...session({ comments: [comment] }), extra: true }).ok).toBe(false);
  });
});
