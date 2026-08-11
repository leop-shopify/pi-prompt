import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../ansi.js";
import { createPromptEditorComponent } from "../prompt-editor/tui.js";
import type { PromptEditorOutcome } from "../prompt-editor/types.js";
import { makeTestTheme } from "./helpers.js";

function setup(
  initial: Parameters<typeof createPromptEditorComponent>[0]["initial"] = {},
  readClipboardPaste: () => Promise<string | null> = async () => null,
) {
  const done = vi.fn<(outcome: PromptEditorOutcome) => void>();
  const returnToInput = vi.fn<(text: string) => void>();
  const requestRender = vi.fn();
  const keybindings = { matches: (data: string, binding: string) => binding === "app.clipboard.pasteImage" && data === "\x16" };
  const component = createPromptEditorComponent({
    tui: { terminal: { rows: 36 } as never, requestRender }, theme: makeTestTheme(), keybindings,
    initial, done, returnToInput, readClipboardPaste,
  });
  return { component, done, returnToInput, requestRender };
}

describe("prompt editor TUI", () => {
  it("renders generation depth without Skills or Execution and shows the exact navigation hint", () => {
    const { component } = setup();
    const text = component.render(120).map(stripAnsi).join("\n");
    expect(text).toContain("No plan");
    expect(text).toContain("Quick win");
    expect(text).toContain("Normal plan");
    expect(text).toContain("Careful");
    expect(text).toContain("Hard thinker");
    expect(text).toContain("Fully orchestrated");
    expect(text).toContain("Full-screen editor only");
    expect(text).toContain("tab/shift+tab navigate");
    expect(text).not.toMatch(/\bskills\b/i);
    expect(text).not.toMatch(/\bexecution\b/i);
    expect(text).not.toMatch(/multiplier|custom number/i);
  });

  it("keeps every rendered row within narrow widths", () => {
    const { component } = setup();
    const lines = component.render(40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("focuses the prompt, keeps Enter as newline, and makes Ctrl+Enter send in default No plan", () => {
    const { component, done } = setup({ text: "first" });
    component.handleInput?.("\r");
    component.handleInput?.("second");
    component.handleInput?.("\x1b[13;5u");
    expect(done).toHaveBeenCalledWith({
      kind: "direct-send",
      submission: { text: "first\nsecond", mode: "normal", saveAsTemplate: false },
    });
  });

  it.each([
    { label: "image path", clipboard: "/tmp/pi-clipboard-image.png", expected: "inspect /tmp/pi-clipboard-image.png" },
    { label: "text fallback", clipboard: "copied\ntext", expected: "inspect copied\ntext" },
  ])("pastes a clipboard $label through Pi's configured Ctrl+V binding", async ({ clipboard, expected }) => {
    const readClipboardPaste = vi.fn(async () => clipboard);
    const { component, done, requestRender } = setup({ text: "inspect " }, readClipboardPaste);
    component.handleInput?.("\x16");
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalledTimes(3));
    component.handleInput?.("\x1b[13;5u");
    expect(readClipboardPaste).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ submission: expect.objectContaining({ text: expected }) }));
  });

  it("makes Ctrl+Enter generate when a planning mode was explicitly selected", () => {
    const { component, done } = setup({ text: "plan it", mode: "normal" });
    component.handleInput?.("\x1b[13;5u");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ kind: "generate", submission: expect.objectContaining({ mode: "normal" }) }));
  });


  it("uses Ctrl+Shift+Enter only for explicit direct send", () => {
    const { component, done } = setup({ text: "send directly" });
    component.handleInput?.("\x1b[13;6u");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ kind: "direct-send" }));
  });

  it("cycles generation mode through the remaining focus order", () => {
    const { component, done } = setup({ text: "plan" });
    component.handleInput?.("\x1b[Z"); // mode
    component.handleInput?.("\x1b[C"); // quick win
    component.handleInput?.("\x1b[C"); // normal
    component.handleInput?.("\x1b[C"); // careful
    component.handleInput?.("\t"); // editor
    component.handleInput?.("\t"); // template
    component.handleInput?.("\x1b[Z"); // editor
    component.handleInput?.("\x1b[13;5u");
    const submission = done.mock.calls[0]?.[0];
    expect(submission).toMatchObject({ kind: "generate", submission: { mode: "careful", text: "plan" } });
    expect(submission).not.toHaveProperty("submission.execution");
    expect(submission).not.toHaveProperty("submission.selectedSkills");
  });

  it("moves the complete text back to Pi input and supports the draft/discard/edit escape flow", () => {
    const editing = setup({ text: "keep me\nall of it" });
    editing.component.handleInput?.("\x1b");
    editing.component.handleInput?.("\x1b");
    expect(editing.done).not.toHaveBeenCalled();
    editing.component.handleInput?.("\x1b[112;7u");
    expect(editing.returnToInput).toHaveBeenCalledWith("keep me\nall of it");
    expect(editing.done).toHaveBeenCalledWith({ kind: "exit" });

    const draft = setup({ text: "draft me", draftId: "d1" });
    draft.component.handleInput?.("\x1b");
    draft.component.handleInput?.("k");
    expect(draft.done).toHaveBeenCalledWith({ kind: "keep-draft", text: "draft me", draftId: "d1" });
  });
});
