import type { ParsedPromptOption, PromptBranchResult, PromptOptionDecision } from "./types.js";
import { parsePromptOptions } from "./parser.js";

export function selectedOptionsInOrder(
  options: ParsedPromptOption[],
  decisions: Map<string, PromptOptionDecision>,
): ParsedPromptOption[] {
  return options.filter((option) => decisions.get(option.id) === "selected");
}

export function decisionRecord(decisions: Map<string, PromptOptionDecision>): Record<string, PromptOptionDecision> {
  return Object.fromEntries(decisions.entries()) as Record<string, PromptOptionDecision>;
}

export function assembleFinalPrompt(originalPrompt: string, selectedOptions: ParsedPromptOption[]): string {
  const detailedPrompt = selectedOptions
    .map((option) => option.exactText.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");

  return [
    "[original prompt]",
    "",
    originalPrompt.trim(),
    "",
    "[detailed prompt]",
    "",
    detailedPrompt,
  ].join("\n").trim();
}

/**
 * Backwards-compatible name for older callers/tests. This is no longer an LLM
 * synthesis prompt: prompt-build V2 assembles only user-selected exactText.
 */
export function buildFinalSelectionPrompt(
  originalPrompt: string,
  selectedBranches: PromptBranchResult[],
  extraInput: string,
  _skillContext = "",
): string {
  const selectedOptions = selectedBranches.flatMap((branch) => parsePromptOptions(branch));
  const extra = extraInput.trim().length > 0
    ? [{
        id: "manual-extra",
        branchIndex: Number.MAX_SAFE_INTEGER,
        moduleId: "manual-extra",
        label: "Manual extra input",
        exactText: extraInput.trim(),
        rationale: "Manual user-provided prompt text.",
        evidence: "Provided by the user during prompt-build review.",
        source: "manual",
      }]
    : [];
  return assembleFinalPrompt(originalPrompt, [...selectedOptions, ...extra]);
}
