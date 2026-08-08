import { describe, expect, it } from "vitest";
import { GENERATION_MODE_ORDER, GENERATION_PROFILES } from "../plan/modes.js";
import {
  PROMPT_FIELD_FOCUS_ORDER, PROMPT_PLANNING_MODE_ORDER, createPromptEditorState,
  cycleGenerationMode, generationModeHelp,
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

  it("uses only the remaining prompt controls in the focus order and state", () => {
    const state = createPromptEditorState();
    expect(PROMPT_FIELD_FOCUS_ORDER).toEqual(["mode", "editor", "saveAsTemplate"]);
    expect(state).not.toHaveProperty("execution");
    expect(state).not.toHaveProperty("selectedSkills");
    expect(state).not.toHaveProperty("skillQuery");
  });

  it("renders help directly from immutable profile data", () => {
    expect(generationModeHelp("careful")).toContain(GENERATION_PROFILES.careful.summary);
    expect(generationModeHelp("hard-thinker")).toContain(GENERATION_PROFILES["hard-thinker"].recommendedFor);
  });
});
