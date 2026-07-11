import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PlanController, type CreatePlanInput, type LoadedPrivateSkills } from "../plan/controller.js";
import type { PlanBranchEntry } from "../plan/locator.js";
import { recoverPlanFromBranch } from "../plan/recovery.js";
import { createPlanRepository, type PlanRecoveryWarning } from "../plan/repository.js";
import { readPlanFile } from "../plan/session-files.js";
import type { PlanSession, SafeError } from "../plan/types.js";
import { captureSkills, createAppendLocator, createSkillPort, safeRuntimeId } from "./pi-adapters.js";
import { registerLivePlanActivity, updateLivePlanActivity, type MutableLivePlanActivity } from "./live-activity.js";
import { showPlanProgress } from "./progress.js";
import type { CurrentAgentPlanBridge } from "./current-agent-bridge.js";

export interface NewControllerInput extends Omit<CreatePlanInput, "skills"> { readonly selectedSkillNames: readonly string[] }
export interface CreatedControllerStack { readonly controller: PlanController; readonly loadedSkills: LoadedPrivateSkills }
export interface RecoveredControllerStack {
  readonly controller: PlanController | null; readonly state: PlanSession | null;
  readonly warnings: readonly PlanRecoveryWarning[]; readonly reservedIds: readonly string[];
}
export type ControllerFactoryResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SafeError };
export interface ControllerStackFactory {
  create(ctx: ExtensionContext, input: NewControllerInput): Promise<ControllerFactoryResult<CreatedControllerStack>>;
  recover(ctx: ExtensionContext): Promise<ControllerFactoryResult<RecoveredControllerStack>>;
}

export function createControllerStackFactory(pi: ExtensionAPI, bridge: CurrentAgentPlanBridge): ControllerStackFactory {
  const buildOptions = (ctx: ExtensionContext, repository: ReturnType<typeof createPlanRepository>, prompt: string) => {
    const activity: MutableLivePlanActivity = {};
    const generator = bridge.createGenerator(ctx.isIdle.bind(ctx), (update) => {
      const current = updateLivePlanActivity(activity, update);
      showPlanProgress(ctx, {
        headline: current.headline, prompt,
        detail: `${current.summary} · Advisory budget: ${current.budgetMinutes} min${current.overBudget ? " · over budget" : ""}`,
      });
    });
    return { activity, options: {
      repository, generator, appendLocator: createAppendLocator(pi), skills: createSkillPort(pi),
      idFactory: safeRuntimeId, clock: () => new Date(), stager: { stage: (value: string) => ctx.ui.setEditorText(value) },
      readPlan: (sessionId: string) => readPlanFile(repository.rootDir, sessionId),
    } };
  };
  return {
    async create(ctx, input) {
      const loaded = await captureSkills(pi, input.selectedSkillNames);
      if (!loaded.ok) return failed("skill-context-unavailable", "Selected skill context is unavailable or changed.");
      const repository = createPlanRepository();
      const built = buildOptions(ctx, repository, input.prompt);
      const controller = await PlanController.create(built.options, {
        prompt: input.prompt, cwd: input.cwd, skills: loaded.value.references, execution: input.execution, mode: input.mode,
      });
      if (!controller.ok) { await built.options.generator.close(); await repository.close(); return controller; }
      registerLivePlanActivity(controller.value, built.activity);
      return { ok: true, value: { controller: controller.value, loadedSkills: loaded.value } };
    },
    async recover(ctx) {
      const repository = createPlanRepository();
      let recovered;
      try { recovered = await recoverPlanFromBranch(branchEntries(ctx), repository); }
      catch { await repository.close(); return failed("recovery-failed", "The saved plan could not be recovered."); }
      if (!recovered.state) {
        await repository.close();
        return { ok: true, value: { controller: null, state: null, warnings: recovered.warnings, reservedIds: recovered.reservedIds } };
      }
      const built = buildOptions(ctx, repository, recovered.state.source.prompt);
      const controller = PlanController.fromRecovered(built.options, recovered.state, recovered.reservedIds);
      if (!controller.ok) { await built.options.generator.close(); await repository.close(); return controller; }
      registerLivePlanActivity(controller.value, built.activity);
      return { ok: true, value: { controller: controller.value, state: recovered.state, warnings: recovered.warnings, reservedIds: recovered.reservedIds } };
    },
  };
}
function branchEntries(ctx: ExtensionContext): readonly PlanBranchEntry[] {
  return ctx.sessionManager.getBranch().map((entry) => ({ type: entry.type, ...(entry.type === "custom" ? { customType: entry.customType, data: entry.data } : {}) }));
}
function failed<T = never>(code: string, message: string): ControllerFactoryResult<T> { return { ok: false, error: { code, message } }; }
