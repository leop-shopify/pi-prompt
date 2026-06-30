import { describe, expect, it } from "vitest";
import {
  assembleFinalPrompt,
  branchIndexFromAgentName,
  branchTaskPrompt,
  isPlanningAgentName,
  MULTIPLIER_CHOICES,
  buildFinalSelectionPrompt,
  buildSkillInstruction,
  explanationFromBranchOutput,
  fallbackBranchPlans,
  multiplierValue,
  normalizeBranchPlans,
  optionCountFromBranchOutput,
  optionPreviewFromBranchOutput,
  parsePromptOptions,
  planPrompt,
  promptOptionChecklistText,
  renderBranchChecklistBody,
  skillSuggestions,
  titleFromBranchOutput,
} from "../prompt-build.js";

describe("prompt-build helpers", () => {
  it("resolves multiplier choices independently from per-branch option limits", () => {
    expect(MULTIPLIER_CHOICES).toEqual(["none", "1", "2", "3", "5", "10", "custom"]);
    expect(multiplierValue("none", "")).toBeNull();
    expect(multiplierValue("1", "")).toBe(1);
    expect(multiplierValue("3", "")).toBe(3);
    expect(multiplierValue("5", "")).toBe(5);
    expect(multiplierValue("custom", "17")).toBe(17);
    expect(multiplierValue("custom", "nope")).toBeNull();
    expect(multiplierValue("custom", "0")).toBeNull();
  });

  it("classifies prompt-build agent reports without treating planning reports as branches", () => {
    expect(isPlanningAgentName("pre-build-1")).toBe(true);
    expect(isPlanningAgentName("prompt-branch-1")).toBe(false);
    expect(branchIndexFromAgentName("prompt-branch-1")).toBe(1);
    expect(branchIndexFromAgentName("prompt-branch-10")).toBe(10);
    expect(branchIndexFromAgentName("pre-build-1")).toBeNull();
    expect(branchIndexFromAgentName("prefix-prompt-branch-1")).toBeNull();
  });

  it("suggests unselected skills by query", () => {
    expect(skillSuggestions(["rails-engineer", "javascript-engineer", "test-expert"], "eng", ["rails-engineer"])).toEqual([
      "javascript-engineer",
    ]);
  });

  it("builds topic prompts that construct prompt options without solving the goal", () => {
    const prompt = branchTaskPrompt("make this better", 2, 5, "<skill name=\"skill-a\">instructions</skill>", {
      index: 2,
      title: "MVP topic",
      brief: "Keep only the useful minimum.",
    });
    expect(prompt).toContain("prompt-building topic agent 2 of 5");
    expect(prompt).toContain("Do NOT solve the user's underlying goal now");
    expect(prompt).toContain("exactText");
    expect(prompt).toContain("rationale");
    expect(prompt).toContain("evidence");
    expect(prompt).toContain("JSON CONTRACT — branch response");
    expect(prompt).toContain("JSON.parse as-is");
    expect(prompt).toContain("Top-level keys: branch and candidates only");
    expect(prompt).toContain("Never return an empty response");
    expect(prompt).toContain("3-5 actionable candidate items total");
    expect(prompt).toContain('"candidates"');
    expect(prompt).not.toContain('"modules"');
    expect(prompt).toContain("Assigned topic: MVP topic");
    expect(prompt).toContain("<skill name=\"skill-a\">instructions</skill>");
    expect(prompt).toContain("Original user goal/prompt:\nmake this better");
  });

  it("extracts a branch title from JSON or the first heading", () => {
    expect(titleFromBranchOutput(JSON.stringify({ branch: { title: "Structured path" }, modules: [] }), 1)).toBe("Structured path");
    expect(titleFromBranchOutput("# Path 3: MVP route\n\nbody", 3)).toBe("Path 3: MVP route");
    expect(titleFromBranchOutput("body only", 4)).toBe("Path 4");
  });

  it("assembles the final prompt deterministically from only selected exactText", () => {
    const final = assembleFinalPrompt("original", [
      {
        id: "a",
        branchIndex: 1,
        moduleId: "scope",
        label: "Scope",
        exactText: "Keep the scope to the smallest useful fix.",
        rationale: "reason not written",
        evidence: "evidence not written",
        source: "Path 1",
      },
      {
        id: "b",
        branchIndex: 2,
        moduleId: "verify",
        label: "Verify",
        exactText: "Run the narrowest relevant test and report the exact command.",
        rationale: "reason not written",
        evidence: "evidence not written",
        source: "Path 2",
      },
    ]);

    expect(final).toBe([
      "[original prompt]",
      "",
      "original",
      "",
      "[detailed prompt]",
      "",
      "Keep the scope to the smallest useful fix.",
      "",
      "Run the narrowest relevant test and report the exact command.",
    ].join("\n"));
    expect(final).not.toContain("reason not written");
    expect(final).not.toContain("evidence not written");
  });

  it("keeps the legacy final-selection helper deterministic", () => {
    const prompt = buildFinalSelectionPrompt(
      "original",
      [{
        index: 1,
        title: "Path 1: Concrete",
        output: JSON.stringify({ modules: [{ id: "scope", candidates: [
          { exactText: "Do one thing well.", rationale: "r1", evidence: "e1" },
          { exactText: "Keep scope explicit.", rationale: "r2", evidence: "e2" },
          { exactText: "Report risks clearly.", rationale: "r3", evidence: "e3" },
        ] }] }),
        exitCode: 0,
      }],
      "also include constraints",
      "<skill name=\"skill-a\">instructions</skill>",
    );
    expect(prompt).toBe([
      "[original prompt]",
      "",
      "original",
      "",
      "[detailed prompt]",
      "",
      "Do one thing well.",
      "",
      "Keep scope explicit.",
      "",
      "Report risks clearly.",
      "",
      "also include constraints",
    ].join("\n"));
  });

  it("formats empty skill instructions as prompt-building guidance", () => {
    expect(buildSkillInstruction("")).toContain("No explicit skills selected.");
    expect(buildSkillInstruction("")).toContain("only design prompt text");
  });

  it("builds a planning prompt that treats multiplier as a maximum and forbids solving", () => {
    const prompt = planPrompt("original", 25, "");
    expect(prompt).toContain("at most 25 topics");
    expect(prompt).toContain("maximum, not a quota");
    expect(prompt).toContain("not the solution to the goal itself");
    expect(prompt).toContain("Each topic will be sent to one prompt-building agent");
    expect(prompt).toContain("JSON CONTRACT — planner response");
    expect(prompt).toContain("JSON.parse as-is");
    expect(prompt).toContain("Top-level key: topics only");
    expect(prompt).toContain("topics must be an array with 1-25 items");
  });

  it("parses structured exactText candidates with separate rationale and evidence when the topic has at least three options", () => {
    const options = parsePromptOptions({
      index: 2,
      title: "Verification topic",
      output: JSON.stringify({
        branch: { title: "Verification topic", summary: "Prove the future work." },
        modules: [{
          id: "verify",
          title: "Verification",
          candidates: [
            {
              label: "Narrow tests",
              exactText: "Run the narrowest verification command that proves the changed behavior.",
              rationale: "Prevents broad, slow checks.",
              evidence: "Project has focused test files.",
            },
            {
              label: "Manual proof",
              exactText: "If automation is not available, report the exact manual check and observed result.",
              rationale: "Keeps verification explicit when tests cannot run.",
              evidence: "No external evidence needed.",
            },
            {
              label: "Failure reporting",
              exactText: "If verification fails, stop and report the failing command/output instead of hiding it.",
              rationale: "Prevents false success reports.",
              evidence: "No external evidence needed.",
            },
          ],
        }],
      }),
      exitCode: 0,
    });

    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({
      id: "b2-m1-o1",
      branchIndex: 2,
      moduleId: "verify",
      label: "Narrow tests",
      exactText: "Run the narrowest verification command that proves the changed behavior.",
      rationale: "Prevents broad, slow checks.",
      evidence: "Project has focused test files.",
      source: "Verification topic / Verification",
    });
  });

  it("parses structured options from fenced JSON even when the agent adds a preamble", () => {
    const output = [
      "JSON is valid. Outputting final result:",
      "",
      "```json",
      JSON.stringify({
        branch: { title: "Preamble topic", summary: "Agent added text before JSON." },
        modules: [{
          id: "scope",
          candidates: [
            { exactText: "Option one.", rationale: "r1", evidence: "e1" },
            { exactText: "Option two.", rationale: "r2", evidence: "e2" },
            { exactText: "Option three.", rationale: "r3", evidence: "e3" },
          ],
        }],
      }),
      "```",
    ].join("\n");

    expect(parsePromptOptions({
      index: 1,
      title: "Preamble topic",
      output,
      exitCode: 0,
    })).toHaveLength(3);
  });

  it("parses top-level candidates from JSON with surrounding prose and invalid brace noise", () => {
    const output = [
      "Ignore this invalid object-like note: {not json}",
      JSON.stringify({
        branch: { title: "Top-level candidates", summary: "Uses the hardened response shape." },
        candidates: [
          { exactText: "Option one.", rationale: "r1", evidence: "e1" },
          { exactText: "Option two.", rationale: "r2", evidence: "e2" },
          { exactText: "Option three.", rationale: "r3", evidence: "e3" },
        ],
      }),
      "Trailing report wrapper text should be ignored.",
    ].join("\n");

    expect(parsePromptOptions({
      index: 1,
      title: "Top-level candidates",
      output,
      exitCode: 0,
    })).toHaveLength(3);
  });

  it("limits each structured branch to five selectable options", () => {
    const options = parsePromptOptions({
      index: 1,
      title: "Scope topic",
      output: JSON.stringify({
        modules: [{
          id: "scope",
          candidates: [
            { exactText: "Option one.", rationale: "r1", evidence: "e1" },
            { exactText: "Option two.", rationale: "r2", evidence: "e2" },
            { exactText: "Option three.", rationale: "r3", evidence: "e3" },
            { exactText: "Option four.", rationale: "r4", evidence: "e4" },
            { exactText: "Option five.", rationale: "r5", evidence: "e5" },
            { exactText: "Option six should not be selectable.", rationale: "r6", evidence: "e6" },
          ],
        }],
      }),
      exitCode: 0,
    });

    expect(options).toHaveLength(5);
    expect(options.map((option) => option.exactText)).toEqual(["Option one.", "Option two.", "Option three.", "Option four.", "Option five."]);
  });

  it("extracts explanation and exact option previews from structured branch JSON", () => {
    const output = JSON.stringify({
      branch: { title: "Feature flow", summary: "Make feature choices explicit." },
      modules: [{
        id: "scope",
        candidates: [
          { label: "Simple", exactText: "Keep simple", rationale: "Ship the smallest prompt path.", evidence: "No external evidence needed." },
          { label: "Automation", exactText: "Add automation", rationale: "Use agents after approval.", evidence: "No external evidence needed." },
          { label: "Audit", exactText: "Add audit", rationale: "Write final notes.", evidence: "No external evidence needed." },
        ],
      }],
    });

    expect(explanationFromBranchOutput(output)).toBe("Make feature choices explicit.");
    expect(optionCountFromBranchOutput(output)).toBe(3);
    expect(optionPreviewFromBranchOutput(output, 2)).toEqual([
      "Keep simple",
      "Add automation",
    ]);
  });

  it("renders exactText in the branch checklist instead of hiding it behind labels", () => {
    const option = {
      id: "b1-m1-o1",
      branchIndex: 1,
      moduleId: "scope",
      label: "Short label only",
      exactText: "This exact prompt text must be visible before selection.",
      rationale: "This reason must not replace exactText in the chooser row.",
      evidence: "No external evidence needed.",
      source: "Topic / Scope",
    };
    const theme = { fg: (_name: string, text: string) => text } as any;
    const body = renderBranchChecklistBody(theme, 120, 20, [{ branchIndex: 1, title: "Scope topic", options: [option] }], {
      branchCursor: 0,
      optionCursor: 0,
      phase: "review",
      decisions: new Map(),
      ignoredBranches: new Set(),
    }, { dir: "/tmp/prompt-build/session", sessionId: "session" });

    expect(promptOptionChecklistText(option)).toBe(option.exactText);
    expect(body.join("\n")).toContain(option.exactText);
    expect(body.join("\n")).not.toContain("Short label only — This reason");
  });

  it("requires structured candidates to use exactText, rationale, evidence, and at least three options", () => {
    const output = JSON.stringify({
      modules: [{ id: "scope", candidates: [
        { exactText: "Missing rationale and evidence." },
        { text: "Do one thing well.", rationale: "r", evidence: "e" },
        "String fallback",
      ] }],
    });

    expect(parsePromptOptions({
      index: 1,
      title: "Invalid structured path",
      output,
      exitCode: 0,
    })).toEqual([]);
  });

  it("rejects structured topics with fewer than three valid candidates", () => {
    const output = JSON.stringify({
      modules: [{ id: "scope", candidates: [
        { exactText: "Set a narrow scope.", rationale: "r1", evidence: "e1" },
        { exactText: "List non-goals.", rationale: "r2", evidence: "e2" },
      ] }],
    });

    expect(parsePromptOptions({
      index: 1,
      title: "Too few options",
      output,
      exitCode: 0,
    })).toEqual([]);
  });

  it("does not create fallback selectable options for unstructured branch reports", () => {
    const output = [
      "# Path 1: Feature flow",
      "## Core angle",
      "- Make feature choices explicit.",
      "## Options this path would offer",
      "1. Keep simple — ship the smallest prompt path.",
      "2. Add automation — use agents after approval.",
    ].join("\n");

    const options = parsePromptOptions({
      index: 1,
      title: "Feature flow",
      output,
      exitCode: 0,
    });

    expect(options).toEqual([]);
    expect(optionCountFromBranchOutput(output)).toBe(0);
    expect(optionPreviewFromBranchOutput(output, 2)).toEqual([]);
  });

  it("does not expose options from failed branch reports", () => {
    const output = JSON.stringify({
      modules: [{ id: "scope", candidates: [{ exactText: "Do one thing well." }] }],
    });

    expect(parsePromptOptions({
      index: 1,
      title: "Failed path",
      output,
      exitCode: 1,
      error: "agent reported failure",
    })).toEqual([]);
  });

  it("normalizes planned topics without exceeding the requested max", () => {
    const plans = normalizeBranchPlans(JSON.stringify({ topics: [
      { title: "A", brief: "first" },
      { title: "B", brief: "second" },
      { title: "C", brief: "third" },
    ] }), 2);
    expect(plans).toEqual([
      { index: 1, title: "A", brief: "first" },
      { index: 2, title: "B", brief: "second" },
    ]);
  });

  it("falls back to focused plans instead of maxing out generic branches", () => {
    expect(normalizeBranchPlans("not json", 25)).toEqual(fallbackBranchPlans(25));
    expect(fallbackBranchPlans(25)).toHaveLength(5);
    expect(fallbackBranchPlans(25)[0]?.title).toBe("Goal, scope, and acceptance criteria");
  });
});
