import { describe, expect, it } from "vitest";
import { EXECUTION_LEADERSHIP_BOOTSTRAP, renderPlanMarkdown } from "../plan/classification.js";
import type { PlanDocument } from "../plan/types.js";

const document: PlanDocument = {
  id: "pd_document01",
  title: { id: "pe_title0001", kind: "title", body: "Ship the feature", children: [] },
  elements: [
    { id: "pe_execute01", kind: "execution", body: "Use normal execution.", children: [] },
    { id: "pe_milestone1", kind: "milestone", title: "Milestone one", body: "Implement it.", children: [
      { id: "pe_verify001", kind: "verification", body: "Run the focused tests.", children: [] },
    ] },
    { id: "pe_rollback01", kind: "rollback", body: "Revert the focused change.", children: [] },
  ],
};

describe("plan Markdown", () => {
  it("renders every semantic element deterministically", () => {
    const first = renderPlanMarkdown(document);
    const second = renderPlanMarkdown(document);
    expect(first).toBe(second);
    expect(first).toContain("# Ship the feature");
    expect(first).toContain("Use normal execution.");
    expect(first).toContain("Milestone one");
    expect(first).toContain("Implement it.");
    expect(first).toContain("Run the focused tests.");
    expect(first).toContain("Revert the focused change.");
  });

  it("keeps the fixed execution-leadership prelude independent of selected context", () => {
    expect(EXECUTION_LEADERSHIP_BOOTSTRAP).toContain("## Execution leadership");
    expect(EXECUTION_LEADERSHIP_BOOTSTRAP).not.toContain("<skill");
  });
});
