import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDirectPromptMessage, promptFieldFocusForInput, stripLeadingPromptCommand, takeEditorText } from "../index.js";

function makeCtx(initial: string): { ctx: ExtensionContext; getText: () => string } {
  let text = initial;
  const ui = {
    getEditorText: () => text,
    setEditorText: vi.fn((next: string) => {
      text = next;
    }),
  };
  const ctx = { ui } as unknown as ExtensionContext;
  return { ctx, getText: () => text };
}

describe("prompt field focus navigation", () => {
  const KEY = {
    tab: "\t",
    shiftTab: "\x1b[Z",
    up: "\x1b[A",
    down: "\x1b[B",
  } as const;

  it("cycles fields with tab and shift+tab only", () => {
    expect(promptFieldFocusForInput("editor", KEY.tab)).toBe("skills");
    expect(promptFieldFocusForInput("skills", KEY.tab)).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("saveAsTemplate", KEY.tab)).toBe("multiplier");
    expect(promptFieldFocusForInput("editor", KEY.shiftTab)).toBe("multiplier");
    expect(promptFieldFocusForInput("multiplier", KEY.shiftTab)).toBe("saveAsTemplate");
    expect(promptFieldFocusForInput("editor", KEY.up)).toBeNull();
    expect(promptFieldFocusForInput("editor", KEY.down)).toBeNull();
  });

  it("can omit the save-as-template field from focus navigation", () => {
    expect(promptFieldFocusForInput("skills", KEY.tab, false)).toBe("multiplier");
    expect(promptFieldFocusForInput("multiplier", KEY.shiftTab, false)).toBe("skills");
  });
});

describe("prompt command message building", () => {
  it("prefixes selected slash commands before skill context", () => {
    const message = buildDirectPromptMessage("Implement the change", "<skill>skill content</skill>", ["/goal"]);

    expect(message).toBe([
      "/goal <skill>skill content</skill>",
      "",
      "User prompt:",
      "Implement the change",
    ].join("\n"));
  });

  it("does not duplicate a command already present in template text", () => {
    expect(buildDirectPromptMessage("/goal Implement the change", "", ["/goal"])).toBe("/goal Implement the change");
  });

  it("strips a leading slash command from loaded template body text", () => {
    expect(stripLeadingPromptCommand("  /goal\nImplement the change", "/goal")).toBe("  Implement the change");
  });
});

describe("takeEditorText", () => {
  it("returns the current input and clears it", () => {
    const { ctx, getText } = makeCtx("half-written thought");
    const moved = takeEditorText(ctx);
    expect(moved).toBe("half-written thought");
    expect(getText()).toBe("");
  });

  it("does not call setEditorText when the input is empty", () => {
    const { ctx } = makeCtx("");
    const moved = takeEditorText(ctx);
    expect(moved).toBe("");
    expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
  });
});
