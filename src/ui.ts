import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { padTo } from "./ansi.js";

function repeat(ch: string, n: number): string {
  return n > 0 ? ch.repeat(n) : "";
}

export interface FrameOptions {
  width: number;
  height: number;
  theme: Theme;
  title: string;
  /** Pre-rendered body lines (each already styled, <= contentWidth). */
  body: string[];
  /** Footer line shown inside the bottom border area. */
  footer?: string;
  color?: "accent" | "border" | "borderMuted";
  paddingX?: number;
}

/**
 * Draw a titled outer frame with an optional footer row. Body lines are padded
 * to the content width; the frame always returns exactly `height` lines.
 */
export function renderFrame(options: FrameOptions): string[] {
  const { width, height, theme, title, body, footer } = options;
  const color = options.color ?? "accent";
  const paddingX = options.paddingX ?? 1;

  const innerWidth = Math.max(1, width - 2);
  const contentWidth = Math.max(1, innerWidth - paddingX * 2);
  const sidePadding = " ".repeat(paddingX);

  const titleText = truncateToWidth(` ${title} `, Math.max(1, innerWidth - 2), "", false);
  const leftPad = 1;
  const rightPad = Math.max(0, innerWidth - visibleWidth(titleText) - leftPad);
  const top = theme.fg(color, `╭${repeat("─", leftPad)}`) + theme.fg("accent", theme.bold(titleText)) +
    theme.fg(color, `${repeat("─", rightPad)}╮`);
  const bottom = theme.fg(color, `╰${repeat("─", innerWidth)}╯`);

  // Reserve rows: top border + bottom border, plus footer (separator + line) if present.
  const footerRows = footer !== undefined ? 2 : 0;
  const bodyRows = Math.max(0, height - 2 - footerRows);

  const lines: string[] = [top];

  for (let i = 0; i < bodyRows; i += 1) {
    const content = `${sidePadding}${padTo(body[i] ?? "", contentWidth)}${sidePadding}`;
    lines.push(`${theme.fg(color, "│")}${content}${theme.fg(color, "│")}`);
  }

  if (footer !== undefined) {
    const sep = theme.fg(color, `├${repeat("─", innerWidth)}┤`);
    const footerContent = `${sidePadding}${padTo(truncateToWidth(footer, contentWidth, "…", false), contentWidth)}${sidePadding}`;
    lines.push(sep);
    lines.push(`${theme.fg(color, "│")}${footerContent}${theme.fg(color, "│")}`);
  }

  lines.push(bottom);
  return lines;
}

/** Number of non-body rows the frame consumes for a given footer presence. */
export function frameChromeHeight(hasFooter: boolean): number {
  return 2 + (hasFooter ? 2 : 0);
}

/** Horizontal padding the frame reserves on each side of the body. */
export function frameContentWidth(width: number, paddingX = 1): number {
  return Math.max(1, width - 2 - paddingX * 2);
}

/**
 * Build a footer hint bar from key/label pairs, styled dim with accented keys.
 */
export function buildShortcutBar(theme: Theme, pairs: Array<[string, string]>): string {
  return pairs
    .map(([key, label]) => `${theme.fg("accent", key)} ${theme.fg("dim", label)}`)
    .join(theme.fg("dim", "  •  "));
}

/** A small inline status note (e.g. preloaded file, selection size). */
export function statusNote(theme: Theme, text: string): string {
  return theme.fg("muted", text);
}
