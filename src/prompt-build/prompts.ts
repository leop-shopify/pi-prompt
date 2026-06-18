import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PromptBranchPlan } from "./types.js";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "skills");

function promptBuildSkillReferences(): string {
  return [
    "Extension-local prompt-building skill references are available if useful:",
    `- pre-build-prompt: ${join(SKILLS_DIR, "pre-build-prompt", "SKILL.md")}`,
    `- probe: ${join(SKILLS_DIR, "probe", "SKILL.md")}`,
    `- prompt-building: ${join(SKILLS_DIR, "prompt-building", "SKILL.md")}`,
    "Read only the relevant file(s). These skills guide prompt construction; they do not authorize solving the underlying goal now.",
  ].join("\n");
}

export function multiplierValue(choice: string, customValue: string): number | null {
  if (choice === "none") return null;
  if (choice === "custom") {
    const parsed = Number.parseInt(customValue.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const parsed = Number.parseInt(choice, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function renderMultiplierChoice(choice: string, customValue: string): string {
  if (choice === "none") return "nothing";
  if (choice === "custom") return customValue.trim().length > 0 ? `[${customValue.trim()}]` : "[]";
  return choice;
}

export function buildSkillInstruction(skillContext: string): string {
  if (skillContext.trim().length === 0) {
    return [
      "No explicit skills selected.",
      "If a skill would normally solve the user's goal, do not simulate that skill now; only design prompt text the user can choose to send later.",
    ].join("\n");
  }

  return [
    "Selected skill instructions are reference material for prompt construction only.",
    "Use them to identify the right role, constraints, evidence expectations, verification path, and failure modes for the future prompt.",
    "Do not execute the selected skill's job now. Do not solve the user's underlying goal. Do not broaden scope because a skill mentions adjacent best practices.",
    "Every proposed module must be exact text the user could choose to include in the future prompt, with rationale/evidence kept outside exactText.",
    "Skill context:",
    skillContext.trim(),
  ].join("\n");
}

export function skillSuggestions(skills: string[], query: string, selected: string[], limit = 6): string[] {
  const q = query.trim().toLowerCase();
  const selectedSet = new Set(selected);
  return skills
    .filter((skill) => !selectedSet.has(skill))
    .filter((skill) => q.length === 0 || skill.toLowerCase().includes(q))
    .slice(0, limit);
}

export function planPrompt(originalPrompt: string, requestedMaxBranches: number, skillContext = ""): string {
  return [
    `Plan a prompt-building multiplication run with at most ${requestedMaxBranches} topics.`,
    "This is pre-build work: construct useful prompt topics for the user's goal, not the solution to the goal itself.",
    "The multiplier is a maximum, not a quota. Use fewer topics when fewer distinct prompt topics are actually valuable.",
    "A good topic is a concrete prompt-building subject that one probe agent can extend with options, such as scope boundaries, role/delegation, evidence sources, execution sequence, verification, safety constraints, or product tradeoffs.",
    "Each topic will be sent to one prompt-building agent. That agent must stay on the assigned topic and produce options only for extending/refining that same topic.",
    "Stay read-only. Do not edit files, commit, deploy, or mutate external systems.",
    buildSkillInstruction(skillContext),
    promptBuildSkillReferences(),
    "",
    "Original user goal/prompt:",
    originalPrompt.trim(),
    "",
    "Return ONLY JSON in this shape. Do not include markdown, headings, commentary, or prose outside the JSON:",
    JSON.stringify({
      topics: [
        {
          title: "short topic title",
          brief: "what this topic should cover, why it is distinct, and what kinds of exact prompt options the assigned agent should propose",
        },
      ],
    }),
  ].join("\n");
}

export function branchTaskPrompt(
  originalPrompt: string,
  branchIndex: number,
  totalBranches: number,
  skillContext = "",
  plan?: PromptBranchPlan,
): string {
  return [
    `You are prompt-building topic agent ${branchIndex} of ${totalBranches}.`,
    "Your job is to generate reviewable options for your assigned prompt-building topic. Do NOT solve the user's underlying goal now.",
    "Use read-only resources when they help you make better prompt text: local files, project docs, tests, logs, web/internal docs, or other read/research tools available in this Pi session.",
    "Stay read-only: do not edit files, commit, deploy, install packages, start services, or mutate external systems.",
    "The user will literally choose which exactText candidates become part of the final prompt. Anything not in exactText is explanation only and will not be written.",
    "Keep exactText concise but complete. It should be copy-ready instruction text, not a vague label. Put reasons, evidence, and tradeoffs in separate fields.",
    plan ? `Assigned topic: ${plan.title}\n${plan.brief}` : "Assigned topic: propose the most useful distinct prompt-building topic you can find.",
    buildSkillInstruction(skillContext),
    promptBuildSkillReferences(),
    "",
    "Original user goal/prompt:",
    originalPrompt.trim(),
    "",
    "Return ONLY JSON. No markdown, headings, commentary, or prose outside the JSON. Unstructured output is invalid and will be treated as a failed branch.",
    "If you cannot produce at least three valid structured candidates for this assigned topic, report failure instead of returning prose, fewer options, or fallback text.",
    "Shape:",
    JSON.stringify({
      branch: {
        index: branchIndex,
        title: "topic title",
        summary: "one sentence explaining what this prompt-building topic contributes",
      },
      modules: [
        {
          id: "scope",
          title: "Module title shown to the user",
          candidates: [
            {
              label: "short chooser label",
              exactText: "Exact prompt text the user may select. This text must stand alone in the final prompt.",
              rationale: "Why this candidate is useful; not written into the final prompt.",
              evidence: "Files/docs/observations used, or 'No external evidence needed'; not written into the final prompt.",
            },
          ],
        },
      ],
    }),
    "",
    "Candidate requirements:",
    "- Produce at least 3 valid candidates total for this assigned topic. Fewer than 3 candidates is invalid output.",
    "- Every candidate must extend or refine the same assigned topic. Do not drift into another topic or implementation plan.",
    "- Prefer one candidate per coherent option; include alternatives only when the user faces a real choice.",
    "- Do not include fabricated facts in exactText. If evidence is uncertain, say that in rationale/evidence, not exactText.",
    "- Do not ask follow-up questions. Encode assumptions or decision points as selectable prompt text instead.",
  ].join("\n");
}
