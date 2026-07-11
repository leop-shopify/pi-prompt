import type { ExecutionKind, GenerationMode } from "../plan/types.js";

export type PromptFieldFocus = "mode" | "execution" | "editor" | "skills" | "saveAsTemplate";

export interface PromptEditorInitialState {
  readonly text?: string;
  readonly draftId?: string;
  readonly preloadedPath?: string;
  readonly templateName?: string;
  readonly templateKind?: "goal" | "loop";
  readonly mode?: GenerationMode;
  readonly execution?: ExecutionKind;
  readonly selectedSkills?: readonly string[];
}

export interface PromptEditorSubmission {
  readonly text: string;
  readonly mode: GenerationMode;
  readonly execution: ExecutionKind;
  readonly selectedSkills: readonly string[];
  readonly saveAsTemplate: boolean;
}

export type PromptEditorOutcome =
  | { readonly kind: "generate"; readonly submission: PromptEditorSubmission }
  | { readonly kind: "direct-send"; readonly submission: PromptEditorSubmission }
  | { readonly kind: "exit" }
  | { readonly kind: "keep-draft"; readonly text: string; readonly draftId?: string }
  | { readonly kind: "stash"; readonly text: string };
