import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../ansi.js";
import { createPromptEditorComponent } from "../prompt-editor/tui.js";
import type { PromptEditorOutcome } from "../prompt-editor/types.js";
import { makeTestTheme } from "./helpers.js";

function setup(initial: Parameters<typeof createPromptEditorComponent>[0]["initial"] = {}) {
  const done = vi.fn<(outcome: PromptEditorOutcome) => void>();
  const requestRender = vi.fn();
  const pi = {
    getCommands: () => [
      { name: "test-expert", source: "skill", sourceInfo: { path: "/skills/test/SKILL.md", source: "x", scope: "user", origin: "top-level" } },
      { name: "goal", source: "extension", sourceInfo: { path: "x", source: "x", scope: "user", origin: "top-level" } },
    ],
  } as Pick<ExtensionAPI, "getCommands">;
  const component = createPromptEditorComponent({
    pi, tui: { terminal: { rows: 36 } as never, requestRender }, theme: makeTestTheme(), initial, done,
  });
  return { component, done, requestRender };
}

describe("prompt editor TUI", () => {
  it("renders No plan before all five mode labels, editor help, execution, and skills-only copy", () => {
    const { component } = setup();
    const text = component.render(120).map(stripAnsi).join("\n");
    expect(text).toContain("No plan");
    expect(text).toContain("Quick win");
    expect(text).toContain("Normal plan");
    expect(text).toContain("Careful");
    expect(text).toContain("Hard thinker");
    expect(text).toContain("Fully orchestrated");
    expect(text).toContain("Full-screen editor only");
    expect(text).toContain("Goal (/goal)");
    expect(text).toContain("Loop (/loop)");
    expect(text).not.toContain("Create Goal");
    expect(text.indexOf("Normal")).toBeLessThan(text.indexOf("Goal (/goal)"));
    expect(text.indexOf("Goal (/goal)")).toBeLessThan(text.indexOf("Loop (/loop)"));
    expect(text).not.toMatch(/multiplier|custom number/i);
    expect(text).not.toContain("type skill name or /command");
  });

  it("describes accepted Spec dispatch as exact trailing Markdown without an execution prefix", () => {
    for (const kind of ["goal", "loop"] as const) {
      const { component } = setup({ execution: { kind } }); const text = component.render(120).map(stripAnsi).join("\n");
      expect(text).toContain("authenticated wrapper"); expect(text).toContain("exact Markdown without /goal or /loop prefix"); expect(text).not.toContain("without a wrapper");
    }
  });

  it("keeps every rendered row within narrow widths", () => {
    const { component } = setup({ selectedSkills: ["test-expert"] });
    const lines = component.render(40);
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(lines.map(stripAnsi).join("\n")).toContain("@test-expert");
  });

  it("focuses the prompt, keeps Enter as newline, and makes Ctrl+Enter send in default No plan", () => {
    const { component, done } = setup({ text: "first" });
    component.handleInput?.("\r");
    component.handleInput?.("second");
    component.handleInput?.("\x1b[13;5u");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({
      kind: "direct-send",
      submission: expect.objectContaining({ text: "first\nsecond", mode: "normal", execution: { kind: "normal" } }),
    }));
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

  it("cycles mode and exclusive execution without changing selected skills", () => {
    const { component, done } = setup({ text: "plan", selectedSkills: ["test-expert"] });
    component.handleInput?.("\x1b[Z"); // execution
    component.handleInput?.("\x1b[Z"); // mode
    component.handleInput?.("\x1b[C"); // quick win
    component.handleInput?.("\x1b[C"); // normal
    component.handleInput?.("\x1b[C"); // careful
    component.handleInput?.("\t"); // execution
    component.handleInput?.("\x1b[C"); // execution: goal
    component.handleInput?.("\x1b[13;5u");
    expect(done).toHaveBeenCalledWith(expect.objectContaining({ submission: expect.objectContaining({
      mode: "careful", execution: { kind: "goal" }, selectedSkills: ["test-expert"],
    }) }));
  });

  it("supports stash and the draft/discard/edit escape flow", () => {
    const editing = setup({ text: "keep me" });
    editing.component.handleInput?.("\x1b");
    editing.component.handleInput?.("\x1b");
    expect(editing.done).not.toHaveBeenCalled();
    editing.component.handleInput?.("\x1b[112;7u");
    expect(editing.done).toHaveBeenCalledWith({ kind: "stash", text: "keep me" });

    const draft = setup({ text: "draft me", draftId: "d1" });
    draft.component.handleInput?.("\x1b");
    draft.component.handleInput?.("k");
    expect(draft.done).toHaveBeenCalledWith({ kind: "keep-draft", text: "draft me", draftId: "d1" });
  });
});
