import type { PlanController } from "../plan/controller.js";
import type { CurrentAgentActivityUpdate, PlanningActivityPhase } from "./current-agent-bridge.js";

export interface LivePlanActivity {
  readonly phase: PlanningActivityPhase;
  readonly headline: string;
  readonly summary: string;
  readonly progress?: { readonly summary: string; readonly updatedAt: string };
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly budgetMinutes: number;
  readonly overBudget: boolean;
  readonly adapter: "delegated" | "direct";
  readonly model: CurrentAgentActivityUpdate["model"];
  readonly primary: { readonly count: 0 | 1; readonly status: CurrentAgentActivityUpdate["primaryStatus"] };
  readonly helpers: { readonly supported: false; readonly active: 0 };
  readonly timeline: readonly { readonly phase: PlanningActivityPhase; readonly at: string }[];
}

export interface MutableLivePlanActivity {
  current?: LivePlanActivity;
  readonly clock?: () => Date;
}

const activityByController = new WeakMap<PlanController, MutableLivePlanActivity>();
const MAX_TIMELINE_ENTRIES = 12;
const TEMPLATES: Readonly<Record<PlanningActivityPhase, readonly [headline: string, summary: string]>> = Object.freeze({
  "capability-detected": ["Delegated planning is available", "A validated teams capability requires one primary planner."],
  "primary-starting": ["Primary planner is starting", "The one read-only primary planner is receiving its private mission."],
  "primary-active": ["Primary planner is active", "The primary planner may inspect repository evidence independently."],
  "waiting-report": ["Waiting for the primary report", "One primary planner is working independently."],
  "report-received": ["Primary result received", "The complete private result is ready for direct validation."],
  synthesizing: ["Refining the plan", "The planner is improving the result."],
  validating: ["Validating the plan", "Schema, privacy, and Implementation Tasks checks are running."],
  recovering: ["Refining the plan", "The planner is correcting the result."],
  completed: ["Plan generation completed", "The validated plan is ready for durable review."],
  "direct-fallback": ["Planning directly", "Validated teams capability was unavailable before planning started."],
  paused: ["Plan generation paused", "The saved request and history remain available for a recoverable retry."],
});

export function registerLivePlanActivity(controller: PlanController, activity: MutableLivePlanActivity): void {
  activityByController.set(controller, activity);
}

export function livePlanActivity(controller: PlanController): LivePlanActivity | undefined {
  const activity = activityByController.get(controller);
  if (!activity?.current) return undefined;
  return materialize(activity.current, activity.clock?.() ?? new Date());
}

export function updateLivePlanActivity(activity: MutableLivePlanActivity, update: CurrentAgentActivityUpdate): LivePlanActivity {
  const previous = activity.current;
  const [headline, summary] = TEMPLATES[update.phase];
  const timeline = previous?.timeline.at(-1)?.phase === update.phase
    ? previous.timeline
    : [...(previous?.timeline ?? []), Object.freeze({ phase: update.phase, at: update.updatedAt })].slice(-MAX_TIMELINE_ENTRIES);
  const next: LivePlanActivity = Object.freeze({
    phase: update.phase, headline, summary,
    ...(update.progress ? { progress: Object.freeze({ ...update.progress }) } : {}),
    startedAt: update.startedAt, updatedAt: update.updatedAt,
    budgetMinutes: update.budgetMinutes, overBudget: overBudget(update.startedAt, update.budgetMinutes, activity.clock?.() ?? new Date(update.updatedAt)),
    adapter: update.adapter,
    model: Object.freeze({ ...update.model }),
    primary: Object.freeze({ count: update.primaryCount, status: update.primaryStatus }),
    helpers: Object.freeze({ supported: false, active: 0 }),
    timeline: Object.freeze(timeline),
  });
  activity.current = next;
  return next;
}

function materialize(activity: LivePlanActivity, now: Date): LivePlanActivity {
  const currentOverBudget = overBudget(activity.startedAt, activity.budgetMinutes, now);
  return currentOverBudget === activity.overBudget ? activity : Object.freeze({ ...activity, overBudget: currentOverBudget });
}
function overBudget(startedAt: string, budgetMinutes: number, now: Date): boolean {
  return now.getTime() - Date.parse(startedAt) > budgetMinutes * 60_000;
}
