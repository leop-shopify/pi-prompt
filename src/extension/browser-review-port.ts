import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBrowserLauncher, type BrowserLauncher } from "../plan/browser-launcher.js";
import { startPlanHttpHost, type PlanHttpHost } from "../plan/http-server.js";
import type { PlanController } from "../plan/controller.js";
import type { PromptEditorInitialState } from "../prompt-editor/types.js";
import type { PlanReadyInput, PlanReviewPort } from "./runtime.js";
import { clearPlanProgress, showPlanProgress } from "./progress.js";
import { livePlanActivity } from "./live-activity.js";

export interface BrowserReviewPortOptions {
  readonly launcher: BrowserLauncher;
  readonly reopen: (ctx: ExtensionContext, initial: PromptEditorInitialState) => void | Promise<void>;
}

export function createBrowserPlanReviewPort(options: BrowserReviewPortOptions): PlanReviewPort {
  let active: PlanHttpHost | null = null;
  let activeController: PlanController | null = null;
  let activeContext: ExtensionContext | null = null;
  let epoch = 0;

  const replaceHost = async (input: PlanReadyInput): Promise<void> => {
    const ownedEpoch = ++epoch;
    if (active) await active.close();
    if (activeContext) clearPlanProgress(activeContext);
    active = null; activeController = null; activeContext = null;
    const privateState = input.controller.snapshot();
    if (!privateState) throw new Error("plan-state-unavailable");
    const host = await startPlanHttpHost({
      controller: input.controller,
      activity: () => livePlanActivity(input.controller),
      reopenInPi: async () => {
        if (epoch !== ownedEpoch) return;
        active = null; activeController = null;
        if (activeContext) { clearPlanProgress(activeContext); activeContext = null; }
        const state = input.controller.snapshot() ?? privateState;
        await options.reopen(input.ctx, {
          text: state.source.prompt,
          mode: state.generation.mode,
          execution: state.execution,
          selectedSkills: state.source.skills.map((skill) => skill.name),
        });
      },
    });
    if (epoch !== ownedEpoch) { await host.close(); return; }
    active = host; activeController = input.controller; activeContext = input.ctx;
    showPlanProgress(input.ctx, {
      headline: "Review server is running",
      prompt: privateState.source.prompt,
      detail: "Agent is working; opening live plan progress in your browser",
    });
    try { await options.launcher.open(host.launchUrl); }
    catch (error) {
      if (active === host) { active = null; activeController = null; }
      if (activeContext === input.ctx) { clearPlanProgress(input.ctx); activeContext = null; }
      await host.close(); throw error;
    }
    showPlanProgress(input.ctx, {
      headline: privateState.document ? "Plan review is open" : "Agent is working",
      prompt: privateState.source.prompt,
      detail: privateState.document ? "The local review server will close when this review ends" : "The browser will update automatically when the plan is ready",
    });
  };

  return {
    async start(input: PlanReadyInput) {
      const state = input.controller.snapshot();
      if (!state?.generationJob || (state.status !== "generating" && state.status !== "revising")) throw new Error("plan-not-generating");
      if (active && activeController === input.controller) return;
      await replaceHost(input);
    },
    async ready(input: PlanReadyInput) {
      const state = input.controller.snapshot();
      const reviewable = state?.status === "ready" || state?.status === "error" || state?.status === "awaiting-clarification";
      if (!state || !reviewable || (!state.document && !state.clarifications?.pending)) throw new Error("plan-not-reviewable");
      if (!active || activeController !== input.controller) await replaceHost(input);
      clearPlanProgress(input.ctx);
    },
    async close() {
      epoch += 1;
      const host = active; const ctx = activeContext;
      active = null; activeController = null; activeContext = null;
      if (host) await host.close();
      if (ctx) clearPlanProgress(ctx);
    },
  };
}

export function defaultBrowserPlanReviewPort(
  pi: Pick<ExtensionAPI, "exec">,
  reopen: (ctx: ExtensionContext, initial: PromptEditorInitialState) => void | Promise<void>,
): PlanReviewPort {
  return createBrowserPlanReviewPort({ launcher: createBrowserLauncher(pi), reopen });
}
