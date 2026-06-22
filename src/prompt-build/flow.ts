import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assembleFinalPrompt, selectedOptionsInOrder } from "./assembly.js";
import { branchFeatureOrder, normalizeBranchPlans, parsePromptOptions, titleFromBranchOutput } from "./parser.js";
import { branchTaskPrompt, planPrompt } from "./prompts.js";
import { createPromptBuildProgress } from "./progress.js";
import {
  appendPromptBuildBranchReport,
  createPromptBuildSession,
  writeFinalPromptBuildSelection,
  writePromptBuildPlans,
  writePromptBuildReviewState,
} from "./storage.js";
import type {
  PromptBranchPlan,
  PromptBranchResult,
  PromptBuildReviewState,
  PromptBuildSessionFiles,
} from "./types.js";
import { createPromptBuildReviewState, runPromptQuestionnaire, snapshotReviewState } from "./review-ui.js";

interface ActivePromptBuildRun {
  teamName: string;
  phase: "planning" | "branches" | "review";
  originalPrompt: string;
  requestedMaxBranches: number;
  skillContext: string;
  selectedUseSkillItems: string[];
  ctx: ExtensionContext;
  expectedReports: number;
  reports: PromptBranchResult[];
  session: PromptBuildSessionFiles;
  reviewState?: PromptBuildReviewState;
}

interface PromptBuildAgentReportEvent {
  teamName?: string;
  name?: string;
  report?: string;
  ok?: boolean;
}

interface PromptBuildProgressEvent {
  teamName?: string;
  text?: string;
  started?: number;
  total?: number;
  status?: string;
}

export interface PromptBuildFlowController {
  start(ctx: ExtensionContext, text: string, multiplier: number, skillContext: string, selectedUseSkillItems?: string[]): Promise<void>;
  resume(ctx: ExtensionContext): Promise<void>;
  handleProgress(event: unknown): void;
  handleError(event: unknown): void;
  handleAgentReport(event: unknown): Promise<void>;
  shutdown(): void;
}

export interface PromptBuildFlowOptions {
  openPromptEditor?: (ctx: ExtensionContext, finalPrompt: string, options?: { selectedUseSkillItems?: string[] }) => Promise<void>;
}

export function createPromptBuildFlow(pi: ExtensionAPI, options: PromptBuildFlowOptions = {}): PromptBuildFlowController {
  const progress = createPromptBuildProgress();
  let activeRun: ActivePromptBuildRun | undefined;

  async function start(ctx: ExtensionContext, text: string, multiplier: number, skillContext: string, selectedUseSkillItems: string[] = []): Promise<void> {
    const teamName = `prompt-build-${Date.now()}`;
    try {
      const session = await createPromptBuildSession({
        originalPrompt: text,
        cwd: ctx.cwd,
        teamName,
        requestedMaxBranches: multiplier,
        skillContext,
      });

      activeRun = {
        teamName,
        phase: "planning",
        originalPrompt: text,
        requestedMaxBranches: multiplier,
        skillContext,
        selectedUseSkillItems,
        ctx,
        expectedReports: 1,
        reports: [],
        session,
      };

      progress.set(ctx, `using ${multiplier}x prompt multiplier`);
      pi.events?.emit?.("pi-prompt:prompt-build:start", {
        teamName,
        cwd: ctx.cwd,
        description: "pi-prompt pre-build prompt planner",
        prompts: [planPrompt(text, multiplier, skillContext)],
        agentNamePrefix: "pre-build",
        thinking: "medium",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Prompt-build could not start: ${message}`, "error");
      activeRun = undefined;
    }
  }

  async function resume(ctx: ExtensionContext): Promise<void> {
    const run = activeRun;
    if (!run) {
      ctx.ui.notify("No prompt-build session to resume", "info");
      return;
    }
    run.ctx = ctx;
    if (run.phase === "review" || (run.phase === "branches" && run.reports.length >= run.expectedReports)) {
      await openReview(run);
      return;
    }

    progress.set(ctx, `building prompt — ${run.reports.length}/${run.expectedReports} branches completed`);
    ctx.ui.notify("Prompt-build is still running; review will open when branches finish", "info");
  }

  function handleProgress(event: unknown): void {
    const payload = event as PromptBuildProgressEvent;
    const run = activeRun;
    if (!run || payload.teamName !== run.teamName) return;
    if (run.phase === "planning" && (payload.status === "started" || payload.status === "spawned")) {
      const started = payload.started ?? 0;
      const suffix = payload.status === "spawned" ? ` · ${started}/1 pre-build agent started` : " · starting pre-build agent";
      progress.set(run.ctx, `using ${run.requestedMaxBranches}x prompt multiplier · pi-extended-teams${suffix} · medium effort`);
      return;
    }
    const text = payload.text ?? (payload.total ? `using pi-extended-teams · ${payload.started ?? 0}/${payload.total} prompt-build agents started` : "using pi-extended-teams · working");
    progress.set(run.ctx, text);
  }

  function handleError(event: unknown): void {
    const payload = event as { teamName?: string; error?: unknown };
    const run = activeRun;
    if (!run || payload.teamName !== run.teamName) return;
    const error = typeof payload.error === "string" ? payload.error : "unknown prompt-build error";
    progress.set(run.ctx, `building prompt — failed: ${error}`);
    run.ctx.ui.notify(`Prompt-build failed: ${error}`, "error");
  }

  async function handleAgentReport(event: unknown): Promise<void> {
    const payload = event as PromptBuildAgentReportEvent;
    const run = activeRun;
    if (!run || payload.teamName !== run.teamName || typeof payload.report !== "string") return;

    try {
      if (run.phase === "planning") {
        await handlePlanningReport(run, payload.report);
        return;
      }

      if (run.phase !== "branches") return;
      await handleBranchReport(run, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress.set(run.ctx, `building prompt — failed: ${message}`);
      run.ctx.ui.notify(`Prompt-build failed: ${message}`, "error");
    }
  }

  async function handlePlanningReport(run: ActivePromptBuildRun, report: string): Promise<void> {
    const plans = normalizeBranchPlans(report, run.requestedMaxBranches);
    await writePromptBuildPlans(run.session, plans);

    run.phase = "branches";
    run.expectedReports = plans.length;
    run.reports = [];
    progress.set(run.ctx, `pre-build complete · ${plans.length} paths planned; starting pi-extended-teams readers`);
    pi.events?.emit?.("pi-prompt:prompt-build:start", {
      teamName: run.teamName,
      cwd: run.ctx.cwd,
      description: "pi-prompt prompt-build branches",
      prompts: plans.map((plan: PromptBranchPlan) => branchTaskPrompt(run.originalPrompt, plan.index, plans.length, run.skillContext, plan)),
      agentNamePrefix: "prompt-branch",
      thinking: "high",
    });
  }

  async function handleBranchReport(run: ActivePromptBuildRun, payload: PromptBuildAgentReportEvent): Promise<void> {
    const index = branchIndexFromAgentName(payload.name) ?? run.reports.length + 1;
    let branch = {
      index,
      title: titleFromBranchOutput(payload.report ?? "", index),
      output: payload.report ?? "",
      exitCode: payload.ok === false ? 1 : 0,
      error: payload.ok === false ? "agent reported failure" : undefined,
    } satisfies PromptBranchResult;

    if (!branch.error && parsePromptOptions(branch).length === 0) {
      branch = {
        ...branch,
        exitCode: 1,
        error: "branch returned no structured exactText candidates",
      };
    }

    run.reports.push(branch);
    await appendPromptBuildBranchReport(run.session, branch);
    progress.set(run.ctx, `building prompt — ${run.reports.length}/${run.expectedReports} branches completed`);

    if (run.reports.length < run.expectedReports) return;
    await openReview(run);
  }

  async function openReview(run: ActivePromptBuildRun): Promise<void> {
    run.phase = "review";
    run.reports.sort((a, b) => branchFeatureOrder(a.index) - branchFeatureOrder(b.index));
    run.reviewState ??= createPromptBuildReviewState();
    progress.clear(run.ctx);

    const result = await runPromptQuestionnaire(
      run.ctx,
      run.originalPrompt,
      run.reports,
      run.session,
      run.skillContext,
      run.reviewState,
      (snapshot, selectedOptions) => {
        void writePromptBuildReviewState(run.session, snapshot, selectedOptions).catch(() => {});
      },
    );

    if (!result) {
      progress.clear(run.ctx);
      await writePromptBuildReviewState(
        run.session,
        snapshotReviewState(run.reviewState),
        selectedOptionsInOrder([], run.reviewState.decisions),
      ).catch(() => {});
      run.ctx.ui.notify("Prompt-build paused. Reopen with /prompt resume", "info");
      return;
    }

    const finalPrompt = result.finalPrompt || assembleFinalPrompt(run.originalPrompt, result.selectedOptions);
    await writeFinalPromptBuildSelection(run.session, finalPrompt, result.selectedOptions);
    progress.clear(run.ctx);
    if (options.openPromptEditor) {
      await options.openPromptEditor(run.ctx, finalPrompt, { selectedUseSkillItems: run.selectedUseSkillItems });
    } else {
      run.ctx.ui.setEditorText(finalPrompt);
      run.ctx.ui.notify("Prompt-build rebuilt the prompt input. Review and send it when ready.", "info");
    }
    activeRun = undefined;
  }

  function shutdown(): void {
    progress.shutdown();
  }

  return { start, resume, handleProgress, handleError, handleAgentReport, shutdown };
}

function branchIndexFromAgentName(name: unknown): number | null {
  if (typeof name !== "string") return null;
  const match = name.match(/prompt-branch-(\d+)/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1]!, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
