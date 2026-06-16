import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { compositeAt, highlightRange, padTo, sliceByColumn, stripAnsi } from "../ansi.js";
import { makeTestTheme } from "./helpers.js";

const theme = makeTestTheme();

describe("ansi helpers", () => {
  it("padTo extends to width without trimming styled content", () => {
    const styled = theme.fg("accent", "hi");
    const padded = padTo(styled, 5);
    expect(visibleWidth(padded)).toBe(5);
    expect(stripAnsi(padded)).toBe("hi   ");
  });

  it("sliceByColumn extracts a visible column range", () => {
    const line = "abcdefgh";
    expect(stripAnsi(sliceByColumn(line, 2, 3))).toBe("cde");
    expect(stripAnsi(sliceByColumn(line, 0, 0))).toBe("");
    expect(stripAnsi(sliceByColumn(line, 6, 10))).toBe("gh");
  });

  it("sliceByColumn keeps styling active at the slice start", () => {
    const line = theme.fg("accent", "abcdefgh");
    const slice = sliceByColumn(line, 2, 3);
    expect(stripAnsi(slice)).toBe("cde");
    expect(slice).toContain("\x1b[");
  });

  it("compositeAt overlays at a column and preserves total width", () => {
    const base = "0123456789";
    const composed = compositeAt(base, "XY", 3, 10);
    expect(visibleWidth(composed)).toBe(10);
    expect(stripAnsi(composed)).toBe("012XY56789");
  });

  it("highlightRange wraps a column span and stays width-stable", () => {
    const base = "hello world";
    const out = highlightRange(base, 0, 5, (s) => theme.bg("selectedBg", s), 11);
    expect(visibleWidth(out)).toBe(11);
    expect(stripAnsi(out)).toBe("hello world");
    expect(out).toContain("\x1b[");
  });

  it("handles wide characters by visible width", () => {
    const line = "a漢b"; // widths: 1, 2, 1
    expect(stripAnsi(sliceByColumn(line, 0, 1))).toBe("a");
    expect(stripAnsi(sliceByColumn(line, 1, 2))).toBe("漢");
    expect(stripAnsi(sliceByColumn(line, 3, 1))).toBe("b");
  });
});
