import type { GenerationMode } from "../plan/types.js";

export type PromptFieldFocus = "mode" | "editor" | "saveAsTemplate";

export interface PromptEditorInitialState {
  readonly text?: string;
  readonly draftId?: string;
  readonly preloadedPath?: string;
  readonly templateName?: string;
  readonly templateKind?: "goal" | "loop";
  readonly mode?: GenerationMode;
}

export interface PromptEditorSubmission {
  readonly text: string;
  readonly mode: GenerationMode;
  readonly saveAsTemplate: boolean;
}

export type PromptEditorOutcome =
  | { readonly kind: "generate"; readonly submission: PromptEditorSubmission }
  | { readonly kind: "direct-send"; readonly submission: PromptEditorSubmission }
  | { readonly kind: "exit" }
  | { readonly kind: "keep-draft"; readonly text: string; readonly draftId?: string };
