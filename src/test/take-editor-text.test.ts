import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { takeEditorText } from "../index.js";
import { normalizeEditorSource } from "../prompt-editor/sources.js";
import { promptFieldFocusForInput } from "../prompt-editor/state.js";

function makeCtx(initial: string): { ctx: ExtensionContext; getText: () => string } {
  let text = initial;
  const ui = { getEditorText: () => text, setEditorText: vi.fn((next: string) => { text = next; }) };
  return { ctx: { ui } as unknown as ExtensionContext, getText: () => text };
}

describe("prompt field focus navigation", () => {
  it("cycles through mode, execution, editor, skills, and template", () => {
    expect(promptFieldFocusForInput("mode", "\t")).toBe("execution");
    expect(promptFieldFocusForInput("execution", "\t")).toBe("editor");
    expect(promptFieldFocusForInput("editor", "\t")).toBe("skills");
    expect(promptFieldFocusForInput("skills", "\t")).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("saveAsTemplate", "\t")).toBe("mode");
    expect(promptFieldFocusForInput("mode", "\x1b[Z")).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("editor", "\x1b[A")).toBeNull();
  });
});

describe("execution source normalization", () => {
  it("removes one or repeated matching controlled prefixes", () => {
    expect(normalizeEditorSource("/loop /loop Build it")).toEqual({
      ok: true, value: { promptText: "Build it", execution: { kind: "loop" } },
    });
  });

  it("rejects typed and selected conflicts and mixed typed prefixes", () => {
    expect(normalizeEditorSource("/loop Build it", { kind: "goal" })).toMatchObject({ ok: false });
    expect(normalizeEditorSource("/goal /loop Build it")).toMatchObject({ ok: false });
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
