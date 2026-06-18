import type { ParsedPromptOption, PromptBranchPlan, PromptBranchResult } from "./types.js";

const FALLBACK_BRANCHES: Array<Omit<PromptBranchPlan, "index">> = [
  {
    title: "Goal, scope, and acceptance criteria",
    brief: "Turn the user's goal into precise scope boundaries, non-goals, assumptions, and done criteria for the future prompt.",
  },
  {
    title: "Execution path and sequencing",
    brief: "Design prompt modules that make the future agent choose an evidence-backed implementation/investigation sequence instead of jumping to a solution.",
  },
  {
    title: "Expertise, tools, and delegation",
    brief: "Identify the roles, skills, tools, and agent handoffs the future prompt should explicitly request or forbid.",
  },
  {
    title: "Verification and evidence",
    brief: "Design prompt modules for tests, checks, proof, observability, and final reporting expectations.",
  },
  {
    title: "Risks, reversibility, and constraints",
    brief: "Surface safety, product, data, security, production, and rollback constraints that belong in the future prompt.",
  },
];

interface JsonPromptPlan {
  topics?: Array<{ title?: unknown; brief?: unknown }>;
  branches?: Array<{ title?: unknown; brief?: unknown }>;
}

interface JsonPromptOptionCandidate {
  label?: unknown;
  exactText?: unknown;
  rationale?: unknown;
  reason?: unknown;
  evidence?: unknown;
  source?: unknown;
}

interface JsonPromptModule {
  id?: unknown;
  title?: unknown;
  candidates?: unknown;
  options?: unknown;
}

interface JsonBranchOutput {
  branch?: {
    index?: unknown;
    title?: unknown;
    summary?: unknown;
    coreAngle?: unknown;
  };
  modules?: unknown;
  candidates?: unknown;
  options?: unknown;
}

export function fallbackBranchPlans(count: number): PromptBranchPlan[] {
  const total = Math.max(1, Math.min(count, FALLBACK_BRANCHES.length));
  return FALLBACK_BRANCHES.slice(0, total).map((branch, i) => ({
    index: i + 1,
    title: branch.title,
    brief: branch.brief,
  }));
}

export function normalizeBranchPlans(raw: string, requestedMaxBranches: number): PromptBranchPlan[] {
  const max = Math.max(1, requestedMaxBranches);
  const jsonText = extractJsonText(raw) ?? raw;

  try {
    const parsed = JSON.parse(jsonText) as JsonPromptPlan;
    const topics = Array.isArray(parsed.topics) ? parsed.topics : Array.isArray(parsed.branches) ? parsed.branches : [];
    const normalized = topics
      .slice(0, max)
      .map((branch, i) => ({
        index: i + 1,
        title: stringOrDefault(branch.title, `Topic ${i + 1}`),
        brief: stringOrDefault(branch.brief, "Find one useful, non-overlapping prompt-building topic for the future prompt."),
      }))
      .filter((branch) => branch.title.trim().length > 0 || branch.brief.trim().length > 0);
    return normalized.length > 0 ? normalized : fallbackBranchPlans(max);
  } catch {
    return fallbackBranchPlans(max);
  }
}

export function titleFromBranchOutput(output: string, fallbackIndex: number): string {
  const parsed = parseBranchJson(output);
  const jsonTitle = stringValue(parsed?.branch?.title);
  if (jsonTitle) return jsonTitle;

  const heading = output.split("\n").find((line) => /^#\s+/.test(line.trim()));
  if (!heading) return `Path ${fallbackIndex}`;
  return heading.replace(/^#\s+/, "").trim() || `Path ${fallbackIndex}`;
}

export function explanationFromBranchOutput(output: string): string {
  const parsed = parseBranchJson(output);
  const jsonSummary = stringValue(parsed?.branch?.summary) ?? stringValue(parsed?.branch?.coreAngle);
  if (jsonSummary) return jsonSummary;

  const core = sectionText(output, /^##\s+Core angle/i) || sectionText(output, /^##\s+Summary/i);
  const first = core.split("\n").map((line) => line.replace(/^[-*]\s+/, "").trim()).find(Boolean);
  return first ?? "No explanation provided.";
}

export function optionCountFromBranchOutput(output: string): number {
  return parsePromptOptions({ index: 1, title: titleFromBranchOutput(output, 1), output, exitCode: 0 }).length;
}

export function optionPreviewFromBranchOutput(output: string, limit = 3): string[] {
  return parsePromptOptions({ index: 1, title: titleFromBranchOutput(output, 1), output, exitCode: 0 })
    .map((option) => option.exactText)
    .filter(Boolean)
    .slice(0, limit);
}

export function branchFeatureOrder(index: number): number {
  return Number.isFinite(index) && index > 0 ? index : Number.MAX_SAFE_INTEGER;
}

export function parsePromptOptions(branch: PromptBranchResult): ParsedPromptOption[] {
  if (branch.exitCode !== 0 || branch.error) return [];

  const parsed = parseBranchJson(branch.output);
  if (!parsed) return [];

  const options = promptOptionsFromJson(branch, parsed);
  return options.length >= 3 ? options : [];
}

export function parseAllPromptOptions(branches: PromptBranchResult[]): ParsedPromptOption[] {
  return branches
    .sort((a, b) => branchFeatureOrder(a.index) - branchFeatureOrder(b.index))
    .flatMap((branch) => parsePromptOptions(branch));
}

function promptOptionsFromJson(branch: PromptBranchResult, parsed: JsonBranchOutput): ParsedPromptOption[] {
  const modules: JsonPromptModule[] = Array.isArray(parsed.modules)
    ? parsed.modules as JsonPromptModule[]
    : [{ id: "module", title: branch.title, candidates: parsed.candidates ?? parsed.options }];

  const options: ParsedPromptOption[] = [];
  modules.forEach((module, moduleIndex) => {
    const rawCandidates = Array.isArray(module.candidates)
      ? module.candidates
      : Array.isArray(module.options) ? module.options : [];
    const moduleId = stringValue(module.id) ?? `module-${moduleIndex + 1}`;
    const moduleTitle = stringValue(module.title) ?? moduleId;

    rawCandidates.forEach((candidate, optionIndex) => {
      const option = normalizeJsonCandidate(branch, moduleId, moduleTitle, candidate as JsonPromptOptionCandidate | string, moduleIndex, optionIndex);
      if (option) options.push(option);
    });
  });

  return options;
}

function normalizeJsonCandidate(
  branch: PromptBranchResult,
  moduleId: string,
  moduleTitle: string,
  candidate: JsonPromptOptionCandidate | string,
  moduleIndex: number,
  optionIndex: number,
): ParsedPromptOption | null {
  if (typeof candidate === "string") return null;

  const exactText = stringValue(candidate.exactText) ?? "";
  if (!exactText.trim()) return null;

  const label = stringValue(candidate.label) ?? firstLine(exactText);
  const rationale = stringValue(candidate.rationale);
  const evidence = stringValue(candidate.evidence);
  if (!rationale || !evidence) return null;

  return {
    id: optionId(branch.index, moduleIndex, optionIndex),
    branchIndex: branch.index,
    moduleId,
    label,
    exactText: exactText.trim(),
    rationale,
    evidence,
    source: moduleTitle && moduleTitle !== branch.title ? `${branch.title} / ${moduleTitle}` : branch.title,
  };
}

function sectionText(output: string, headingPattern: RegExp): string {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line.trim())) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function parseBranchJson(output: string): JsonBranchOutput | null {
  const trimmed = output.trim();
  const fencedJson = trimmed.match(/^```json\s*([\s\S]*?)```\s*$/i)?.[1]?.trim();
  const jsonText = fencedJson ?? (trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed : null);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as JsonBranchOutput;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonText(raw: string): string | null {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced?.trim()) return fenced.trim();

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) return raw.slice(firstBrace, lastBrace + 1).trim();
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return stringValue(value) ?? fallback;
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean)?.slice(0, 80) || "Prompt option";
}

function optionId(branchIndex: number, moduleIndex: number, optionIndex: number): string {
  return `b${branchIndex}-m${moduleIndex + 1}-o${optionIndex + 1}`;
}
