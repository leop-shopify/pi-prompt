import { Theme } from "@earendil-works/pi-coding-agent";

const FG_KEYS = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning",
  "muted", "dim", "text", "thinkingText", "userMessageText", "customMessageText",
  "customMessageLabel", "toolTitle", "toolOutput", "mdHeading", "mdLink", "mdLinkUrl",
  "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr",
  "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment",
  "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber",
  "syntaxType", "syntaxOperator", "syntaxPunctuation", "thinkingOff", "thinkingMinimal",
  "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
] as const;

const BG_KEYS = [
  "selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg",
] as const;

/** Build a deterministic Theme instance for tests (no TTY dependency). */
export function makeTestTheme(): Theme {
  const fg = Object.fromEntries(FG_KEYS.map((k) => [k, 12])) as Record<(typeof FG_KEYS)[number], number>;
  const bg = Object.fromEntries(BG_KEYS.map((k) => [k, 8])) as Record<(typeof BG_KEYS)[number], number>;
  return new Theme(fg, bg, "256color");
}
