export const PROMPT_BRANCH_OPTION_MIN = 3;
export const PROMPT_BRANCH_OPTION_MAX = 5;

export type MultiplierChoice = "none" | "1" | "2" | "3" | "5" | "10" | "custom";

export const MULTIPLIER_CHOICES: MultiplierChoice[] = ["none", "1", "2", "3", "5", "10", "custom"];

export interface PromptBranchPlan {
  index: number;
  title: string;
  brief: string;
}

export interface PromptBranchResult {
  index: number;
  title: string;
  output: string;
  exitCode: number;
  error?: string;
}

export interface PromptBuildSessionFiles {
  dir: string;
  sessionId: string;
}

export interface ParsedPromptOption {
  id: string;
  branchIndex: number;
  moduleId: string;
  label: string;
  exactText: string;
  rationale: string;
  evidence: string;
  source: string;
}

export type PromptOptionDecision = "selected" | "ignored" | "undecided";

export interface PromptBuildReviewState {
  branchCursor: number;
  optionCursor: number;
  phase: "review";
  decisions: Map<string, PromptOptionDecision>;
  ignoredBranches: Set<number>;
}

export interface PromptBuildReviewSnapshot {
  phase: PromptBuildReviewState["phase"];
  branchCursor: number;
  optionCursor: number;
  decisions: Record<string, PromptOptionDecision>;
  ignoredBranches: number[];
}

export interface PromptBuildReviewResult {
  finalPrompt: string;
  selectedOptions: ParsedPromptOption[];
  decisions: Record<string, PromptOptionDecision>;
}
