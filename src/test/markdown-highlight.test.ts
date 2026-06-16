import { describe, expect, it } from "vitest";
import { stripAnsi } from "../ansi.js";
import { styleInline, styleLine, styleLines } from "../markdown-highlight.js";
import { makeTestTheme } from "./helpers.js";

const theme = makeTestTheme();

function visiblesMatch(raw: string, styled: string): void {
  expect(stripAnsi(styled)).toBe(raw);
}

describe("markdown-highlight width preservation", () => {
  const samples = [
    "# Heading one",
    "## Heading with **bold** inside",
    "plain paragraph text",
    "- a bullet item",
    "1. ordered item",
    "> a blockquote line",
    "text with `inline code` span",
    "text with **bold** and *italic* and ~~strike~~",
    "a [link](https://example.com) here",
    "bare https://example.com/path?x=1 url",
    "---",
    "",
    "    indented code-ish",
    "trailing spaces   ",
    "emoji 😀 and 漢字 widths",
  ];

  it("never changes the visible characters of a styled line", () => {
    for (const sample of samples) {
      const { text } = styleLine(sample, theme, false);
      visiblesMatch(sample, text);
    }
  });

  it("preserves visible text across a fenced code block", () => {
    const lines = ["```ts", "const x = 1", "still code **not bold**", "```", "after **bold**"];
    const styled = styleLines(lines, theme);
    expect(styled).toHaveLength(lines.length);
    for (let i = 0; i < lines.length; i += 1) {
      visiblesMatch(lines[i]!, styled[i]!);
    }
  });

  it("keeps inline markers in place", () => {
    const raw = "mix **b** and `c` and *i*";
    const styled = styleInline(raw, theme);
    visiblesMatch(raw, styled);
  });

  it("applies foreground styling (not a no-op) to headings", () => {
    const { text } = styleLine("# Title", theme, false);
    expect(text).not.toBe("# Title");
    expect(text).toContain("\x1b[");
  });
});
