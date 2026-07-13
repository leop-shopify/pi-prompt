import { describe, expect, it } from "vitest";
import { GENERATION_MODE_ORDER, GENERATION_PROFILES } from "../plan/modes.js";
import {
  EXECUTION_KIND_ORDER, PROMPT_FIELD_FOCUS_ORDER, PROMPT_PLANNING_MODE_ORDER, createPromptEditorState, cycleExecutionKind,
  cycleGenerationMode, generationModeHelp, skillSuggestions,
} from "../prompt-editor/state.js";

describe("prompt editor state", () => {
  it("defaults to an editor-focused No plan choice before five immutable profile-backed choices", () => {
    const state = createPromptEditorState();
    expect(state.mode).toBe("no-plan");
    expect(state.focus).toBe("editor");
    expect(PROMPT_PLANNING_MODE_ORDER).toEqual(["no-plan", "quick-win", "normal", "careful", "hard-thinker", "fully-orchestrated"]);
    expect(GENERATION_MODE_ORDER).toEqual(["quick-win", "normal", "careful", "hard-thinker", "fully-orchestrated"]);
    expect(GENERATION_MODE_ORDER).toHaveLength(5);
    expect(Object.isFrozen(GENERATION_MODE_ORDER)).toBe(true);
    expect(GENERATION_MODE_ORDER.map((mode) => GENERATION_PROFILES[mode].label)).toEqual([
      "Quick win", "Normal plan", "Careful", "Hard thinker", "Fully orchestrated",
    ]);
  });

  it("cycles and wraps No plan with generation modes", () => {
    expect(cycleGenerationMode("no-plan", -1)).toBe("fully-orchestrated");
    expect(cycleGenerationMode("fully-orchestrated", 1)).toBe("no-plan");
    expect(cycleGenerationMode("no-plan", 1)).toBe("quick-win");
  });

  it("keeps exclusive execution separate from skills", () => {
    const state = createPromptEditorState({ execution: { kind: "goal" }, selectedSkills: ["test-expert"] });
    expect(EXECUTION_KIND_ORDER).toEqual(["normal", "goal", "loop"]);
    expect(cycleExecutionKind(state.execution, 1)).toEqual({ kind: "loop" });
    expect(cycleExecutionKind({ kind: "normal" }, 1)).toEqual({ kind: "goal" });
    expect(cycleExecutionKind({ kind: "loop" }, 1)).toEqual({ kind: "normal" });
    expect(state.selectedSkills).toEqual(["test-expert"]);
    expect(state.selectedSkills).not.toContain("/goal");
  });

  it("uses the exact required focus order", () => {
    expect(PROMPT_FIELD_FOCUS_ORDER).toEqual(["mode", "execution", "editor", "skills", "saveAsTemplate"]);
  });

  it("preserves unique selected skills and suggests skills only", () => {
    const state = createPromptEditorState({ selectedSkills: ["security-expert", "security-expert"] });
    expect(state.selectedSkills).toEqual(["security-expert"]);
    expect(skillSuggestions(["security-expert", "test-expert"], "expert", state.selectedSkills)).toEqual(["test-expert"]);
  });

  it("renders help directly from immutable profile data", () => {
    expect(generationModeHelp("careful")).toContain(GENERATION_PROFILES.careful.summary);
    expect(generationModeHelp("hard-thinker")).toContain(GENERATION_PROFILES["hard-thinker"].recommendedFor);
  });
});
