import { matchesKey } from "@earendil-works/pi-tui";
import { GENERATION_MODE_ORDER, GENERATION_PROFILES } from "../plan/modes.js";
import type { GenerationMode } from "../plan/types.js";
import type { PromptEditorInitialState, PromptFieldFocus } from "./types.js";

export const PROMPT_FIELD_FOCUS_ORDER: readonly PromptFieldFocus[] = Object.freeze([
  "mode", "editor", "saveAsTemplate",
]);
export type PromptPlanningMode = "no-plan" | GenerationMode;
export const PROMPT_PLANNING_MODE_ORDER: readonly PromptPlanningMode[] = Object.freeze(["no-plan", ...GENERATION_MODE_ORDER]);

export interface PromptEditorState {
  focus: PromptFieldFocus;
  mode: PromptPlanningMode;
  saveAsTemplate: boolean;
}

export function createPromptEditorState(initial: PromptEditorInitialState = {}): PromptEditorState {
  return {
    focus: "editor",
    mode: initial.mode ?? "no-plan",
    saveAsTemplate: false,
  };
}

export function cycleGenerationMode(mode: PromptPlanningMode, direction: -1 | 1): PromptPlanningMode {
  return cycle(PROMPT_PLANNING_MODE_ORDER, mode, direction);
}

export function promptFieldFocusForInput(current: PromptFieldFocus, data: string): PromptFieldFocus | null {
  if (matchesKey(data, "shift+tab")) return movePromptFieldFocus(current, -1);
  if (matchesKey(data, "tab")) return movePromptFieldFocus(current, 1);
  return null;
}

export function movePromptFieldFocus(current: PromptFieldFocus, direction: -1 | 1): PromptFieldFocus {
  return cycle(PROMPT_FIELD_FOCUS_ORDER, current, direction);
}

export function generationModeHelp(mode: PromptPlanningMode): string {
  if (mode === "no-plan") return "Full-screen editor only. The primary action sends directly without creating a plan.";
  const profile = GENERATION_PROFILES[mode];
  return `${profile.summary} Best for: ${profile.recommendedFor}`;
}

function cycle<T>(values: readonly T[], current: T, direction: -1 | 1): T {
  const index = values.indexOf(current);
  const safeIndex = index >= 0 ? index : 0;
  return values[(safeIndex + direction + values.length) % values.length]!;
}
