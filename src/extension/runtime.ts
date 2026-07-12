import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanController, PlanControllerResult } from "../plan/controller.js";
import { scanPlanBranchLocators, type PlanBranchEntry } from "../plan/locator.js";
import { defaultPlanRepositoryRoot } from "../plan/repository.js";
import type { PlanSession } from "../plan/types.js";
import type { PromptEditorInitialState, PromptEditorSubmission } from "../prompt-editor/types.js";
import { clearPlanProgress, showPlanProgress } from "./progress.js";
import type { ControllerStackFactory } from "./controller-factory.js";

export interface PlanReadyInput {
  readonly controller: PlanController;
  readonly state: PlanSession;
  readonly ctx: ExtensionContext;
}

export interface PlanReviewPort {
  /** Opens live browser progress as soon as a generation job has durably started. */
  start?(input: PlanReadyInput): void | Promise<void>;
  /** Presents the materialized plan, reusing the live listener when already open. */
  ready(input: PlanReadyInput): void | Promise<void>;
  /** Closes the browser listener before its controller is closed or replaced. */
  close?(): void | Promise<void>;
}
export interface RuntimeEditorPort { open(ctx: ExtensionContext, initial: PromptEditorInitialState): void | Promise<void> }

export interface PromptExtensionRuntimeOptions {
  readonly controllers: ControllerStackFactory;
  readonly review: PlanReviewPort;
  readonly editor: RuntimeEditorPort;
}

export interface PromptExtensionRuntime {
  generate(ctx: ExtensionContext, submission: PromptEditorSubmission): Promise<void>;
  resume(ctx: ExtensionContext): Promise<void>;
  /** Returns false only when navigation must be cancelled so closing can be retried. */
  beforeTree(): Promise<boolean>;
  sessionTree(ctx: ExtensionContext): void;
  sessionStart(ctx: ExtensionContext): void;
  /** Returns false when shutdown cleanup failed and remains retryable. */
  shutdown(): Promise<boolean>;
  readonly cachedLocatorCount: number;
}

interface CloseOperation {
  readonly controller: PlanController;
  readonly controllerEpoch: number;
  readonly promise: Promise<boolean>;
}

export function createPromptExtensionRuntime(options: PromptExtensionRuntimeOptions): PromptExtensionRuntime {
  let active: PlanController | null = null;
  let activeEpoch = 0;
  let runtimeEpoch = 0;
  let closeOperation: CloseOperation | null = null;
  let cachedLocatorCount = 0;
  let shutdownComplete = false;
  let replacementTail: Promise<void> = Promise.resolve();

  const nextEpoch = (): number => {
    runtimeEpoch += 1;
    shutdownComplete = false;
    return runtimeEpoch;
  };
  const owns = (controller: PlanController, epoch: number): boolean => (
    runtimeEpoch === epoch && active === controller && activeEpoch === epoch
  );
  const withReplacementLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = replacementTail;
    let release!: () => void;
    replacementTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };

  const closeActive = async (): Promise<boolean> => {
    const controller = active;
    if (!controller) return true;
    if (closeOperation?.controller === controller && closeOperation.controllerEpoch === activeEpoch) {
      return closeOperation.promise;
    }
    const controllerEpoch = activeEpoch;
    const promise = (async (): Promise<boolean> => {
      try {
        await options.review.close?.();
        await controller.close();
      } catch {
        return false;
      }
      if (active === controller && activeEpoch === controllerEpoch) active = null;
      return true;
    })();
    const operation: CloseOperation = { controller, controllerEpoch, promise };
    closeOperation = operation;
    void promise.finally(() => {
      if (closeOperation === operation) closeOperation = null;
    });
    return promise;
  };

  const notifyOwned = (
    ctx: ExtensionContext, controller: PlanController, epoch: number,
    message: string, type: "info" | "warning" | "error",
  ): void => {
    if (owns(controller, epoch)) notifySafe(ctx, message, type);
  };

  const presentIfReady = async (ctx: ExtensionContext, controller: PlanController, epoch: number): Promise<boolean> => {
    if (!owns(controller, epoch)) return false;
    const state = controller.snapshot();
    if (!state || (state.status !== "ready" && state.status !== "awaiting-clarification") || (!state.document && !state.clarifications?.pending)) return false;
    if (!owns(controller, epoch)) return false;
    try {
      await options.review.ready({ controller, state, ctx });
      if (owns(controller, epoch)) clearPlanProgress(ctx);
    } catch { notifyOwned(ctx, controller, epoch, "Browser review could not be opened. Resume the saved plan to try again.", "error"); }
    return owns(controller, epoch);
  };

  const monitorGeneration = async (
    ctx: ExtensionContext, controller: PlanController, epoch: number, completion: Promise<PlanControllerResult>,
  ): Promise<void> => {
    const completed = await completion;
    if (!owns(controller, epoch)) return;
    if (!completed.ok) { notifyOwned(ctx, controller, epoch, completed.error.message, "error"); clearPlanProgress(ctx); return; }
    const next = controller.snapshot();
    if (!next) { notifyOwned(ctx, controller, epoch, "Plan generation ended without saved state.", "error"); clearPlanProgress(ctx); return; }
    if (await presentIfReady(ctx, controller, epoch)) return;
    if (!owns(controller, epoch)) return;
    clearPlanProgress(ctx);
    if (next.lastError) notifyOwned(ctx, controller, epoch, next.lastError.message, "error");
    else notifyOwned(ctx, controller, epoch, "Plan generation paused before a reviewable plan was ready.", "warning");
  };

  const runGeneration = async (ctx: ExtensionContext, controller: PlanController, epoch: number): Promise<void> => {
    if (!owns(controller, epoch)) return;
    const state = controller.snapshot();
    if (!state) { notifyOwned(ctx, controller, epoch, "Plan generation could not start.", "error"); return; }
    const started = await controller.generate({ expectedStateVersion: state.stateVersion });
    if (!owns(controller, epoch)) return;
    if (!started.ok) { notifyOwned(ctx, controller, epoch, started.error.message, "error"); return; }
    if (options.review.start && owns(controller, epoch)) {
      const liveState = controller.snapshot();
      if (liveState) {
        try { await options.review.start({ controller, state: liveState, ctx }); }
        catch {
          const failedState = controller.snapshot();
          if (failedState?.generationJob && owns(controller, epoch)) await controller.pause({ expectedStateVersion: failedState.stateVersion });
          notifyOwned(ctx, controller, epoch, "Live browser progress could not be opened, so planning was paused before writer dispatch.", "error");
          clearPlanProgress(ctx);
          return;
        }
      }
    }
    if (!owns(controller, epoch)) return;
    const dispatched = controller.dispatchGeneration(started.value.jobId);
    if (!dispatched.ok) {
      const failedState = controller.snapshot();
      if (failedState?.generationJob && owns(controller, epoch)) await controller.pause({ expectedStateVersion: failedState.stateVersion });
      notifyOwned(ctx, controller, epoch, dispatched.error.message, "error"); clearPlanProgress(ctx); return;
    }
    void monitorGeneration(ctx, controller, epoch, started.value.completion);
  };

  return {
    get cachedLocatorCount() { return cachedLocatorCount; },

    async generate(ctx, submission) {
      const epoch = nextEpoch();
      showPlanProgress(ctx, {
        headline: "Plan generation started",
        prompt: submission.text,
        detail: `Preparing ${submission.mode} planning`,
      });
      const controller = await withReplacementLock(async (): Promise<PlanController | null> => {
        if (runtimeEpoch !== epoch) return null;
        const closed = await closeActive();
        if (runtimeEpoch !== epoch) return null;
        if (!closed) {
          notifySafe(ctx, "The active plan could not be closed safely. Try again.", "error");
          return null;
        }
        const created = await options.controllers.create(ctx, {
          prompt: submission.text,
          cwd: ctx.cwd,
          selectedSkillNames: submission.selectedSkills,
          execution: submission.execution,
          mode: submission.mode,
        });
        if (runtimeEpoch !== epoch) {
          if (created.ok) {
            active = created.value.controller;
            activeEpoch = epoch;
            await closeActive();
          }
          return null;
        }
        if (!created.ok) { notifySafe(ctx, created.error.message, "error"); return null; }
        active = created.value.controller;
        activeEpoch = epoch;
        return active;
      });
      if (!controller || !owns(controller, epoch)) { clearPlanProgress(ctx); return; }
      await runGeneration(ctx, controller, epoch);
    },

    async resume(ctx) {
      const epoch = nextEpoch();
      const recovered = await withReplacementLock(async () => {
        if (runtimeEpoch !== epoch) return null;
        const closed = await closeActive();
        if (runtimeEpoch !== epoch) return null;
        if (!closed) {
          notifySafe(ctx, "The active plan could not be closed safely. Try again.", "error");
          return null;
        }
        const result = await options.controllers.recover(ctx);
        if (runtimeEpoch !== epoch) {
          if (result.ok && result.value.controller) {
            active = result.value.controller;
            activeEpoch = epoch;
            await closeActive();
          }
          return null;
        }
        if (!result.ok) { notifySafe(ctx, result.error.message, "error"); return null; }
        const controller = result.value.controller;
        if (!controller) { notifySafe(ctx, "No saved plan is available on this branch.", "info"); return null; }
        active = controller;
        activeEpoch = epoch;
        return { controller, warnings: result.value.warnings };
      });
      if (!recovered || !owns(recovered.controller, epoch)) return;
      const controller = recovered.controller;
      if (recovered.warnings.length > 0) {
        notifyOwned(ctx, controller, epoch, "Recovered the newest valid saved plan; one or more newer branch locators were invalid.", "warning");
      }
      let state = controller.snapshot();
      if (!state) { notifyOwned(ctx, controller, epoch, "The saved plan state is unavailable.", "error"); return; }
      if (state.status === "generating" || state.status === "revising") {
        const paused = await controller.pause({ expectedStateVersion: state.stateVersion });
        if (!owns(controller, epoch)) return;
        if (!paused.ok) { notifyOwned(ctx, controller, epoch, paused.error.message, "error"); return; }
        state = controller.snapshot() ?? state;
      }
      if (state.status !== "accepted" && state.status !== "cancelled") {
        const verified = await controller.verifySkills({ expectedStateVersion: state.stateVersion });
        if (!owns(controller, epoch)) return;
        if (!verified.ok && verified.error.code !== "skill-context-changed") {
          notifyOwned(ctx, controller, epoch, verified.error.message, "error"); return;
        }
        state = controller.snapshot() ?? state;
      }
      if (["paused", "error"].includes(state.status) && state.clarifications?.origin && !state.clarifications.pending) {
        const started = await controller.resumeClarification({ expectedStateVersion: state.stateVersion });
        if (!owns(controller, epoch)) return;
        if (!started.ok) { notifyOwned(ctx, controller, epoch, started.error.message, "error"); return; }
        const liveState = controller.snapshot();
        if (options.review.start && liveState) {
          try { await options.review.start({ controller, state: liveState, ctx }); }
          catch {
            const failedState = controller.snapshot();
            if (failedState?.generationJob && owns(controller, epoch)) await controller.pause({ expectedStateVersion: failedState.stateVersion });
            notifyOwned(ctx, controller, epoch, "Live browser progress could not be opened, so planning was paused before writer dispatch.", "error");
            return;
          }
        }
        const dispatched = controller.dispatchGeneration(started.value.jobId);
        if (!dispatched.ok) {
          const failedState = controller.snapshot();
          if (failedState?.generationJob && owns(controller, epoch)) await controller.pause({ expectedStateVersion: failedState.stateVersion });
          notifyOwned(ctx, controller, epoch, dispatched.error.message, "error"); return;
        }
        void monitorGeneration(ctx, controller, epoch, started.value.completion); return;
      }
      if (state.status === "paused" && (state.document || state.clarifications?.pending)) {
        const resumed = await controller.resumeReview({ expectedStateVersion: state.stateVersion });
        if (!owns(controller, epoch)) return;
        if (!resumed.ok) { notifyOwned(ctx, controller, epoch, resumed.error.message, "error"); return; }
        state = controller.snapshot() ?? state;
      }
      if (!owns(controller, epoch)) return;
      if ((state.document && (state.status === "ready" || state.status === "error")) || state.status === "awaiting-clarification") {
        try { await options.review.ready({ controller, state, ctx }); }
        catch { notifyOwned(ctx, controller, epoch, "Browser review could not be opened. Resume the saved plan to try again.", "error"); }
        if (!owns(controller, epoch)) return;
        return;
      }
      if ((state.status === "paused" || state.status === "error") && !state.document) {
        if (!owns(controller, epoch)) return;
        if (state.status === "error") {
          const retry = await ctx.ui.confirm(
            "Retry plan generation?",
            "The initial plan could not be generated. Choose Retry to use the saved request, or return to the editor without starting work.",
          );
          if (!owns(controller, epoch)) return;
          if (retry) {
            showPlanProgress(ctx, { headline: "Plan generation restarted", prompt: state.source.prompt, detail: `Preparing ${state.generation.mode} planning` });
            await runGeneration(ctx, controller, epoch);
            return;
          }
        }
        await options.editor.open(ctx, {
          text: state.source.prompt,
          mode: state.generation.mode,
          execution: state.execution,
          selectedSkills: state.source.skills.map((skill) => skill.name),
        });
        if (!owns(controller, epoch)) return;
        return;
      }
      if (!owns(controller, epoch)) return;
      if (state.status === "accepted") {
        if (!controller.acceptedStagingPending()) {
          notifyOwned(ctx, controller, epoch, "The saved plan was already accepted and has no pending review.", "info");
          return;
        }
        const retry = await ctx.ui.confirm(
          "Retry sending the accepted plan?",
          "The accepted plan was saved but was not sent to the agent. Retry to submit this exact accepted revision now.",
        );
        if (!owns(controller, epoch) || !retry) return;
        const staged = await controller.accept({ expectedStateVersion: state.stateVersion, documentRevision: state.documentRevision, confirmed: true });
        if (!owns(controller, epoch)) return;
        notifyOwned(ctx, controller, epoch, staged.ok ? "The accepted plan was sent to the agent." : staged.error.message, staged.ok ? "info" : "error");
      } else if (state.status === "cancelled") {
        notifyOwned(ctx, controller, epoch, "The saved plan was cancelled and cannot be reviewed.", "info");
      } else if (state.status === "needs-input") {
        notifyOwned(ctx, controller, epoch, "Selected skill context changed. Reopen the prompt to refresh selected skills.", "warning");
      } else {
        notifyOwned(ctx, controller, epoch, state.lastError?.message ?? "The saved plan is not ready for review.", "warning");
      }
    },

    async beforeTree() {
      nextEpoch();
      return withReplacementLock(closeActive);
    },
    sessionTree(ctx) { cachedLocatorCount = scanCurrentBranch(ctx).locators.length; },
    sessionStart(ctx) { cachedLocatorCount = scanCurrentBranch(ctx).locators.length; },
    async shutdown() {
      if (shutdownComplete) return true;
      nextEpoch();
      const closed = await withReplacementLock(closeActive);
      if (closed) shutdownComplete = true;
      return closed;
    },
  };
}

export function defaultPlanReviewPort(): PlanReviewPort {
  return {
    ready({ state, ctx }) {
      ctx.ui.notify(`Plan “${state.document?.title.body ?? "Untitled"}” is persisted and ready for browser review.`, "info");
    },
    close() { /* notification-only test adapter has no listener */ },
  };
}

function scanCurrentBranch(ctx: ExtensionContext) {
  const entries: PlanBranchEntry[] = ctx.sessionManager.getBranch().map((entry) => ({
    type: entry.type,
    ...(entry.type === "custom" ? { customType: entry.customType, data: entry.data } : {}),
  }));
  return scanPlanBranchLocators(entries, defaultPlanRepositoryRoot());
}

function notifySafe(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, type);
}
