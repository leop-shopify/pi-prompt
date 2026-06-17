import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { takeEditorText } from "../index.js";

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
