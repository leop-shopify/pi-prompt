import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PROMPT_BUILD_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface PromptBuildProgressController {
  set(ctx: ExtensionContext, text: string): void;
  clear(ctx: ExtensionContext): void;
  shutdown(): void;
}

export function createPromptBuildProgress(): PromptBuildProgressController {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;

  const clearTimer = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  return {
    set(ctx: ExtensionContext, text: string): void {
      clearTimer();
      let invalidate: (() => void) | undefined;

      ctx.ui.setWidget?.("00-prompt-build-progress", (_tui: unknown, _theme: Theme) => ({
        render(width: number): string[] {
          const frame = PROMPT_BUILD_SPINNER[frameIndex % PROMPT_BUILD_SPINNER.length] ?? "⠋";
          return renderBluePromptBuildWidget(Math.max(1, width), frame, text);
        },
        invalidate(): void {
          invalidate?.();
        },
      }), { placement: "belowEditor" });

      timer = setInterval(() => {
        frameIndex += 1;
        invalidate?.();
      }, 120);

      // The TUI calls the widget factory immediately; capture invalidation lazily
      // by swapping in a second widget with access to the real TUI object.
      ctx.ui.setWidget?.("00-prompt-build-progress", (tui: { requestRender?: () => void }) => {
        invalidate = () => tui.requestRender?.();
        return {
          render(width: number): string[] {
            const frame = PROMPT_BUILD_SPINNER[frameIndex % PROMPT_BUILD_SPINNER.length] ?? "⠋";
            return renderBluePromptBuildWidget(Math.max(1, width), frame, text);
          },
          invalidate(): void {},
        };
      }, { placement: "belowEditor" });
    },

    clear(ctx: ExtensionContext): void {
      clearTimer();
      ctx.ui.setWidget?.("00-prompt-build-progress", undefined);
    },

    shutdown(): void {
      clearTimer();
    },
  };
}

function renderBluePromptBuildWidget(width: number, spinner: string, text: string): string[] {
  const blue = "\x1b[38;5;75m";
  const dimBlue = "\x1b[38;5;67m";
  const reset = "\x1b[0m";
  const innerWidth = Math.max(1, width - 2);
  const title = " prompt build ";
  const right = Math.max(0, innerWidth - visibleWidth(title) - 1);
  const top = `${blue}╭─${title}${"─".repeat(right)}╮${reset}`;
  const bodyText = `${spinner} ${text}`;
  const clipped = truncateToWidth(bodyText, Math.max(1, innerWidth - 2), "…", false);
  const padding = " ".repeat(Math.max(0, innerWidth - 1 - visibleWidth(clipped)));
  const body = `${blue}│${reset} ${dimBlue}${clipped}${reset}${padding}${blue}│${reset}`;
  const bottom = `${blue}╰${"─".repeat(innerWidth)}╯${reset}`;
  return [top, body, bottom];
}
