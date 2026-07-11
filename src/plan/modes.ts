import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerationMode } from "./types.js";

export type PlanningModelSlot = "writing-basic" | "writing-hard";
export interface PlanLevelDefinition {
  readonly mode: GenerationMode;
  readonly label: string;
  readonly summary: string;
  readonly recommendedFor: string;
  readonly timeBudgetMinutes: number;
  readonly modelSlot: PlanningModelSlot;
  readonly fileName: string;
}

export const GENERATION_MODE_ORDER: readonly GenerationMode[] = Object.freeze([
  "quick-win", "normal", "careful", "hard-thinker", "fully-orchestrated",
]);

export const GENERATION_PROFILES: Readonly<Record<GenerationMode, PlanLevelDefinition>> = Object.freeze({
  "quick-win": level("quick-win", "Quick win", "Fast planning for one bounded, low-risk change.", "A small change with obvious scope and verification.", 5, "writing-basic"),
  normal: level("normal", "Normal plan", "Balanced planning for ordinary features and fixes.", "Most repository work that needs a concrete implementation sequence.", 10, "writing-basic"),
  careful: level("careful", "Careful", "Risk-first planning with extra attention to failure paths and reversibility.", "State, persistence, security, compatibility, or release-sensitive work.", 15, "writing-basic"),
  "hard-thinker": level("hard-thinker", "Hard thinker", "Architecture-first planning for difficult boundaries and tradeoffs.", "Protocols, ownership, migrations, and consequential design choices.", 20, "writing-hard"),
  "fully-orchestrated": level("fully-orchestrated", "Fully orchestrated", "Broad planning across complex domains.", "Complex work spanning independent domains or repositories.", 30, "writing-hard"),
});

const packagedRoot = fileURLToPath(new URL("../../plans-mode/", import.meta.url));

/** Loads only an allowlisted packaged planning level. Runtime strings cannot become paths. */
export async function loadPlanLevel(mode: GenerationMode, root = packagedRoot): Promise<string> {
  if (!isGenerationMode(mode)) throw new Error("invalid-plan-level");
  const base = resolve(root);
  const path = resolve(base, GENERATION_PROFILES[mode].fileName);
  const bounded = relative(base, path);
  if (bounded.startsWith("..") || resolve(base, bounded) !== path) throw new Error("invalid-plan-level-path");
  const markdown = await readFile(path, "utf8");
  if (markdown.trim().length === 0) throw new Error("empty-plan-level");
  return markdown.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function isGenerationMode(value: unknown): value is GenerationMode {
  return typeof value === "string" && GENERATION_MODE_ORDER.includes(value as GenerationMode);
}

function level(
  mode: GenerationMode, label: string, summary: string, recommendedFor: string, timeBudgetMinutes: number, modelSlot: PlanningModelSlot,
): PlanLevelDefinition {
  return Object.freeze({ mode, label, summary, recommendedFor, timeBudgetMinutes, modelSlot, fileName: `${mode}.md` });
}
