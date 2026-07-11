import { describe, expect, it } from "vitest";
import { GENERATION_MODE_ORDER, GENERATION_PROFILES, isGenerationMode, loadPlanLevel } from "../plan/modes.js";

describe("packaged planning levels", () => {
  it("loads the exact five allowlisted Markdown files", async () => {
    expect(GENERATION_MODE_ORDER).toEqual(["quick-win", "normal", "careful", "hard-thinker", "fully-orchestrated"]);
    for (const mode of GENERATION_MODE_ORDER) {
      const markdown = await loadPlanLevel(mode);
      expect(markdown).toContain("controller-owned role");
      expect(markdown).toContain("pi_prompt_submit_plan");
      expect(markdown).toContain("never create delegation or helpers independently");
      expect(markdown).toContain("Only a submission-owning run");
      expect(markdown).not.toMatch(/createAgentSession|pi\.events|subprocess|current Pi tool catalog/i);
      expect(GENERATION_PROFILES[mode].fileName).toBe(`${mode}.md`);
      expect(GENERATION_PROFILES[mode].timeBudgetMinutes).toBeGreaterThan(0);
    }
  });

  it("rejects runtime path input instead of resolving it", async () => {
    expect(isGenerationMode("../normal")).toBe(false);
    await expect(loadPlanLevel("../normal" as never)).rejects.toThrow("invalid-plan-level");
    await expect(loadPlanLevel("normal/../../careful" as never)).rejects.toThrow("invalid-plan-level");
  });

  it("keeps definitions immutable and maps planning depth to the appropriate model slot", () => {
    expect(Object.isFrozen(GENERATION_MODE_ORDER)).toBe(true);
    expect(Object.isFrozen(GENERATION_PROFILES)).toBe(true);
    expect(Object.fromEntries(GENERATION_MODE_ORDER.map((mode) => [mode, GENERATION_PROFILES[mode].modelSlot]))).toEqual({
      "quick-win": "writing-basic", normal: "writing-basic", careful: "writing-basic",
      "hard-thinker": "writing-hard", "fully-orchestrated": "writing-hard",
    });
    for (const definition of Object.values(GENERATION_PROFILES)) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.keys(definition).sort()).toEqual(["fileName", "label", "mode", "modelSlot", "recommendedFor", "summary", "timeBudgetMinutes"]);
    }
  });
});
