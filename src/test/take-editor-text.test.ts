import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { takeEditorText } from "../index.js";
import { promptFieldFocusForInput } from "../prompt-editor/state.js";

function makeCtx(initial: string): { ctx: ExtensionContext; getText: () => string } {
  let text = initial;
  const ui = { getEditorText: () => text, setEditorText: vi.fn((next: string) => { text = next; }) };
  return { ctx: { ui } as unknown as ExtensionContext, getText: () => text };
}

describe("prompt field focus navigation", () => {
  it("cycles through mode, editor, and template in both directions", () => {
    expect(promptFieldFocusForInput("mode", "\t")).toBe("editor");
    expect(promptFieldFocusForInput("editor", "\t")).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("saveAsTemplate", "\t")).toBe("mode");
    expect(promptFieldFocusForInput("mode", "\x1b[Z")).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("editor", "\x1b[A")).toBeNull();
  });
});

describe("takeEditorText", () => {
  it("returns the current input and clears it", () => {
    const { ctx, getText } = makeCtx("half-written thought");
    expect(takeEditorText(ctx)).toBe("half-written thought");
    expect(getText()).toBe("");
  });

  it("does not call setEditorText when the input is empty", () => {
    const { ctx } = makeCtx("");
    expect(takeEditorText(ctx)).toBe("");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });
});
