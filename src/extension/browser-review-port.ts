import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createBrowserLauncher, type BrowserLauncher } from "../plan/browser-launcher.js";
import { startPlanHttpHost, type PlanHttpHost } from "../plan/http-server.js";
import type { PlanController } from "../plan/controller.js";
import { defaultPlanRepositoryRoot } from "../plan/repository.js";
import { SpecController } from "../spec/controller.js";
import { SPEC_LOCATOR_CUSTOM_TYPE, scanSpecBranchLocators } from "../spec/locator.js";
import { createSpecRepository } from "../spec/repository.js";
import { captureSpecSource } from "../spec/source.js";
import type { SpecBranchLocator } from "../spec/types.js";
import { safeRuntimeId } from "./pi-adapters.js";
import type { CurrentAgentPlanBridge } from "./current-agent-bridge.js";
import type { PromptEditorInitialState } from "../prompt-editor/types.js";
import type { PlanReadyInput, PlanReviewPort } from "./runtime.js";
import { clearPlanProgress, showPlanProgress } from "./progress.js";
import { livePlanActivity } from "./live-activity.js";

export interface BrowserReviewPortOptions {
  readonly launcher: BrowserLauncher;
  readonly reopen: (ctx: ExtensionContext, initial: PromptEditorInitialState) => void | Promise<void>;
  readonly createSpecController?: (controller: PlanController, ctx: ExtensionContext) => Promise<SpecController | null>;
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
      ...(options.createSpecController ? { createSpecController: () => options.createSpecController!(input.controller, input.ctx) } : {}),
      onTerminalClose: (terminalHost) => {
        if (epoch !== ownedEpoch || active !== terminalHost || activeController !== input.controller || activeContext !== input.ctx) return;
        active = null; activeController = null; activeContext = null;
        clearPlanProgress(input.ctx);
      },
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
    if (epoch !== ownedEpoch) { await host.close(); return; }
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
  pi: Pick<ExtensionAPI, "exec" | "appendEntry" | "sendUserMessage">,
  bridge: CurrentAgentPlanBridge,
  reopen: (ctx: ExtensionContext, initial: PromptEditorInitialState) => void | Promise<void>,
): PlanReviewPort {
  return createBrowserPlanReviewPort({ launcher: createBrowserLauncher(pi), reopen, createSpecController: async (planController, ctx) => {
    const plan = planController.snapshot(); if (!plan) return null;
    const root = defaultPlanRepositoryRoot(); const captured = captureSpecSource(plan, join(root, plan.id)); if (!captured.ok) return null;
    const repository = createSpecRepository({ rootDir: root }); const generator = bridge.createSpecGenerator(ctx.isIdle.bind(ctx));
    const options = {
      repository, generator,
      appendLocator: (locator: SpecBranchLocator) => pi.appendEntry(SPEC_LOCATOR_CUSTOM_TYPE, locator),
      source: { fresh: async () => {
        const current = planController.snapshot(); const value = current ? captureSpecSource(current, join(root, current.id)) : { ok: false as const, issues: [{ code: "plan-unavailable", message: "The current Plan is unavailable." }] };
        return value.ok ? { ok: true as const, value: value.value } : { ok: false as const, error: { code: value.issues[0]?.code ?? "source-unavailable", message: value.issues[0]?.message ?? "Spec source is unavailable." } };
      } },
      idFactory: safeRuntimeId, clock: () => new Date(),
      stager: { stage: (value: string) => { if (ctx.isIdle()) pi.sendUserMessage(value); else pi.sendUserMessage(value, { deliverAs: "followUp" }); } },
    };
    try {
      const entries = ctx.sessionManager.getBranch().map((entry) => ({ type: entry.type, ...(entry.type === "custom" ? { customType: entry.customType, data: entry.data } : {}) }));
      const locators = scanSpecBranchLocators(entries, root).locators.filter((locator) => locator.planSessionId === plan.id); const recovered = await repository.recover(locators);
      const result = recovered.state ? await SpecController.fromRecovered(options, recovered.state, []) : await SpecController.create(options, captured.value);
      if (result.ok) return result.value;
    } catch { /* close the isolated resources below */ }
    await generator.close(); await repository.close(); return null;
  } });
}
