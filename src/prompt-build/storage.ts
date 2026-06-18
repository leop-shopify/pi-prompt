import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ParsedPromptOption,
  PromptBranchPlan,
  PromptBranchResult,
  PromptBuildReviewSnapshot,
  PromptBuildSessionFiles,
} from "./types.js";

interface PromptBuildSessionMetadata {
  sessionId: string;
  createdAt: string;
  cwd?: string;
  teamName?: string;
  requestedMaxBranches?: number;
  skillContextIncluded: boolean;
}

export function promptBuildRoot(): string {
  return join(homedir(), ".pi", "agent", "prompt-build");
}

export async function createPromptBuildSession(params: {
  originalPrompt: string;
  cwd?: string;
  teamName?: string;
  requestedMaxBranches?: number;
  skillContext?: string;
}): Promise<PromptBuildSessionFiles> {
  const sessionId = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(promptBuildRoot(), sessionId);
  await mkdir(dir, { recursive: true });

  const metadata: PromptBuildSessionMetadata = {
    sessionId,
    createdAt: new Date().toISOString(),
    cwd: params.cwd,
    teamName: params.teamName,
    requestedMaxBranches: params.requestedMaxBranches,
    skillContextIncluded: Boolean(params.skillContext?.trim()),
  };

  await writeJson(join(dir, "metadata.json"), metadata);
  await writeFile(join(dir, "original-prompt.md"), `${params.originalPrompt.trim()}\n`, "utf8");
  if (params.skillContext?.trim()) await writeFile(join(dir, "skill-context.md"), `${params.skillContext.trim()}\n`, "utf8");
  await writeJson(join(dir, "state.json"), { phase: "created", decisions: {}, ignoredBranches: [] });

  return { dir, sessionId };
}

export async function writePromptBuildPlans(session: PromptBuildSessionFiles, plans: PromptBranchPlan[]): Promise<void> {
  await writeJson(join(session.dir, "plans.json"), { plans });
}

export async function appendPromptBuildBranchReport(session: PromptBuildSessionFiles, branch: PromptBranchResult): Promise<void> {
  await appendFile(join(session.dir, "branches.jsonl"), `${JSON.stringify(branch)}\n`, "utf8");
}

export async function writePromptBuildBranches(session: PromptBuildSessionFiles, branches: PromptBranchResult[]): Promise<void> {
  await writeFile(
    join(session.dir, "branches.jsonl"),
    branches.map((branch) => JSON.stringify(branch)).join("\n") + (branches.length > 0 ? "\n" : ""),
    "utf8",
  );
}

export async function writePromptBuildReviewState(
  session: PromptBuildSessionFiles,
  snapshot: PromptBuildReviewSnapshot,
  selectedOptions: ParsedPromptOption[] = [],
): Promise<void> {
  await writeJson(join(session.dir, "state.json"), {
    phase: snapshot.phase,
    branchCursor: snapshot.branchCursor,
    optionCursor: snapshot.optionCursor,
    decisions: snapshot.decisions,
    ignoredBranches: snapshot.ignoredBranches,
    selectedOptionIds: selectedOptions.map((option) => option.id),
    updatedAt: new Date().toISOString(),
  });
}

export async function writeFinalPromptBuildSelection(
  session: PromptBuildSessionFiles,
  finalPrompt: string,
  selectedOptions: ParsedPromptOption[] = [],
): Promise<void> {
  await writeFile(join(session.dir, "final-prompt.md"), `${finalPrompt.trim()}\n`, "utf8");
  await writeJson(join(session.dir, "selected-options.json"), { selectedOptions });
}

export async function writePromptBuildSession(
  cwd: string,
  originalPrompt: string,
  branches: PromptBranchResult[],
): Promise<PromptBuildSessionFiles> {
  const session = await createPromptBuildSession({ originalPrompt, cwd });
  await writePromptBuildBranches(session, branches);
  return session;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
