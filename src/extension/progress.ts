import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROGRESS_KEY = "pi-prompt-plan";
const PROMPT_PREVIEW_CODE_POINTS = 140;
const SPINNER = ["◐", "◓", "◑", "◒"] as const;

export interface PlanProgressInput {
  readonly headline: string;
  readonly prompt: string;
  readonly detail?: string;
}

interface ActiveProgress {
  readonly startedAt: number;
  readonly prompt: string;
  readonly timer: ReturnType<typeof setInterval>;
  headline: string;
  detail?: string;
  frame: number;
}

const activeByContext = new WeakMap<ExtensionContext, ActiveProgress>();

export function showPlanProgress(ctx: ExtensionContext, input: PlanProgressInput): void {
  let active = activeByContext.get(ctx);
  if (!active) {
    const created: ActiveProgress = {
      startedAt: Date.now(), prompt: input.prompt, headline: input.headline, detail: input.detail, frame: 0,
      timer: setInterval(() => render(ctx), 250),
    };
    created.timer.unref?.();
    activeByContext.set(ctx, created);
    active = created;
  } else {
    active.headline = input.headline;
    active.detail = input.detail;
  }
  render(ctx);
}

export function clearPlanProgress(ctx: ExtensionContext): void {
  const active = activeByContext.get(ctx);
  if (active) clearInterval(active.timer);
  activeByContext.delete(ctx);
  try { ctx.ui.setStatus(PROGRESS_KEY, undefined); } catch { /* best effort */ }
}

export function promptPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, " ").trim().normalize("NFC");
  const points = [...normalized];
  return points.length <= PROMPT_PREVIEW_CODE_POINTS ? normalized : `${points.slice(0, PROMPT_PREVIEW_CODE_POINTS - 1).join("")}…`;
}

function render(ctx: ExtensionContext): void {
  const active = activeByContext.get(ctx);
  if (!active) return;
  const elapsed = formatElapsed(Date.now() - active.startedAt);
  const headline = `${SPINNER[active.frame % SPINNER.length]} ${active.headline} · ${elapsed}`;
  active.frame += 1;
  try { ctx.ui.setStatus(PROGRESS_KEY, headline); } catch { /* progress must never break generation */ }
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
