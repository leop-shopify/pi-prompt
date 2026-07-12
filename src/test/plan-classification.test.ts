import { describe, expect, it } from "vitest";
import { executionKindForTemplate, formatStagedPlan, normalizeExecutionInput, renderPlanMarkdown } from "../plan/classification.js";
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

function expectNormalized(
  input: string,
  expectedKind: "normal" | "goal" | "loop" | "create-goal",
  expectedText: string,
  selected: "normal" | "goal" | "loop" | "create-goal" = "normal",
): void {
  const result = normalizeExecutionInput(input, selected);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual({ execution: { kind: expectedKind }, promptText: expectedText });
}

describe("execution classification", () => {
  it("maps goal and loop templates to exclusive kinds", () => {
    expect(executionKindForTemplate("goal")).toEqual({ kind: "goal" });
    expect(executionKindForTemplate("loop")).toEqual({ kind: "loop" });
  });

  it("consumes every consecutive exact leading command and deduplicates one kind", () => {
    expectNormalized("/goal /goal\nBuild it", "goal", "Build it");
    expectNormalized("  /loop\t/loop Run it", "loop", "Run it");
    expectNormalized("/create-goal /create-goal\nCreate it", "create-goal", "Create it");
    expectNormalized("/goalie remains text", "normal", "/goalie remains text");
    expectNormalized("/create-goalie remains text", "normal", "/create-goalie remains text");
    expectNormalized("/goal-not-a-command", "normal", "/goal-not-a-command");
  });

  it("rejects mixed typed kinds and typed-vs-selected conflicts", () => {
    expect(normalizeExecutionInput("/goal /loop Build").ok).toBe(false);
    expect(normalizeExecutionInput("/create-goal /goal Build").ok).toBe(false);
    expect(normalizeExecutionInput("/loop Build", "goal").ok).toBe(false);
    expect(normalizeExecutionInput("/create-goal Build", "loop").ok).toBe(false);
    expectNormalized("/loop Build", "loop", "Build", "normal");
    expectNormalized("/goal Build", "goal", "Build", "goal");
    expectNormalized("/create-goal Build", "create-goal", "Build", "create-goal");
  });
});

describe("plan Markdown and final staging", () => {
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

  it("stages exact normal, goal, loop, and create-goal strings without an invented skills label", () => {
    const skills = ["<skill>A</skill>", "<skill>B</skill>"];
    const plan = "# Plan\n\nBody";
    expect(formatStagedPlan(plan, { kind: "normal" }, skills)).toBe("<skill>A</skill>\n\n<skill>B</skill>\n\n# Plan\n\nBody");
    expect(formatStagedPlan(plan, { kind: "goal" }, skills)).toBe("/goal <skill>A</skill>\n\n<skill>B</skill>\n\n# Plan\n\nBody");
    expect(formatStagedPlan(plan, { kind: "loop" }, skills)).toBe("/loop <skill>A</skill>\n\n<skill>B</skill>\n\n# Plan\n\nBody");
    expect(formatStagedPlan(plan, { kind: "create-goal" }, skills)).toBe("/create-goal <skill>A</skill>\n\n<skill>B</skill>\n\n# Plan\n\nBody");
    expect(formatStagedPlan(plan, { kind: "normal" }, skills)).not.toContain("Selected skills:");
  });

  it("strips accidental prefixes and applies at most one controlled first-token prefix", () => {
    expect(formatStagedPlan("/goal /loop\n# Plan", { kind: "goal" })).toBe("/goal # Plan");
    expect(formatStagedPlan("/loop /loop # Plan", { kind: "loop" }).match(/\/(?:goal|loop|create-goal)/g)).toHaveLength(1);
    expect(formatStagedPlan("/goal /create-goal /loop # Plan", { kind: "create-goal" })).toBe("/create-goal # Plan");
    expect(formatStagedPlan("/create-goal # Plan", { kind: "normal" })).toBe("# Plan");
    expect(formatStagedPlan(document, { kind: "goal" }, ["<skill>A</skill>"]).startsWith("/goal <skill>A</skill>\n\n# Ship the feature")).toBe(true);
  });
});
