import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { access, readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createAcceptedPlanSubmitter } from "../extension/controller-factory.js";
import { registerPromptExtension } from "../extension/register.js";
import type { PromptExtensionRuntime } from "../extension/runtime.js";


function makeRuntime(): PromptExtensionRuntime {
  return {
    generate: vi.fn(), resume: vi.fn(), beforeTree: vi.fn(async () => true), sessionTree: vi.fn(), sessionStart: vi.fn(), shutdown: vi.fn(async () => true), cachedLocatorCount: 0,
  };
}
function makePi() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerCommand: vi.fn((name: string, command: unknown) => commands.set(name, command)),
    registerShortcut: vi.fn((key: string, shortcut: unknown) => shortcuts.set(key, shortcut)),
    on: vi.fn((name: string, handler: unknown) => lifecycle.set(name, handler)),
    registerTool: vi.fn(),
    getCommands: vi.fn(() => []), appendEntry: vi.fn(), sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, commands, shortcuts, lifecycle };
}
function ctx(text = "") {
  let editorText = text;
  return {
    cwd: "/repo", mode: "tui", isIdle: () => true,
    ui: {
      getEditorText: () => editorText,
      setEditorText: vi.fn((value: string) => { editorText = value; }),
      notify: vi.fn(),
    },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionCommandContext;
}

describe("extension registration", () => {
  it("guards the first-class teams adapter against swarm dispatch, backend selection, and hard generation timeouts", async () => {
    const bridge = await readFile("src/extension/current-agent-bridge.ts", "utf8");
    const adapter = await readFile("src/extension/teams-planning-adapter.ts", "utf8");
    const source = `${bridge}\n${adapter}`;
    expect(adapter).toContain('event.toolName !== TEAMS_SPAWN_TOOL');
    expect(adapter).toContain("model_slot: this.#options.modelSlot");
    expect(bridge).toContain("profile.modelSlot");
    expect(adapter).not.toMatch(/sendUserMessage\([^)]*spawn_swarm_agents|execute\([^)]*spawn_swarm_agents/);
    expect(source).not.toMatch(/anthropic|openai|claude|gemini|gpt-[0-9]/i);
    expect(source).not.toMatch(/AbortSignal\.timeout|generationTimeout|setTimeout\s*\(/);
    expect(bridge).not.toContain("createAgentSession");
    await expect(access("src/plan/team-adapter.ts")).rejects.toThrow();
    await expect(access("src/plan/generator-types.ts")).rejects.toThrow();
  });

  it("submits an accepted plan immediately instead of copying it into the editor", async () => {
    const sendUserMessage = vi.fn();
    await createAcceptedPlanSubmitter({ sendUserMessage }, { isIdle: () => true }).stage("# Accepted plan");
    expect(sendUserMessage).toHaveBeenCalledWith("# Accepted plan");
    sendUserMessage.mockClear();
    await createAcceptedPlanSubmitter({ sendUserMessage }, { isIdle: () => false }).stage("# Accepted plan");
    expect(sendUserMessage).toHaveBeenCalledWith("# Accepted plan", { deliverAs: "followUp" });
  });

  it("registers only the generic submit tool and public current-agent lifecycle hooks", () => {
    const { pi, lifecycle } = makePi();
    registerPromptExtension(pi);
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "pi_prompt_submit_plan" }));
    expect([...lifecycle.keys()]).toEqual(["input", "before_agent_start", "message_start", "tool_call", "tool_result", "agent_end", "session_start", "session_before_tree", "session_tree", "session_shutdown"]);
  });

  it("registers both aliases, all routes, shortcut, and lifecycle without old prompt-build listeners", async () => {
    const { pi, commands, shortcuts, lifecycle } = makePi();
    const runtime = makeRuntime();
    const runEditor = vi.fn(async () => ({ kind: "exit" as const }));
    registerPromptExtension(pi, { runtime, runEditor });

    expect([...commands.keys()]).toEqual(["prompt", "pi-prompt"]);
    for (const name of ["prompt", "pi-prompt"]) {
      const completions = commands.get(name).getArgumentCompletions("");
      expect(completions.map((item: any) => item.value)).toEqual(["drafts", "goal-templates", "loop-templates", "resume"]);
    }
    expect(shortcuts.has("ctrl+alt+p")).toBe(true);
    expect([...lifecycle.keys()].slice(-4)).toEqual(["session_start", "session_before_tree", "session_tree", "session_shutdown"]);

    const commandCtx = ctx();
    await commands.get("prompt").handler("resume", commandCtx);
    await commands.get("pi-prompt").handler("resume", commandCtx);
    expect(runtime.resume).toHaveBeenCalledTimes(2);
  });


  it("returns Pi's public cancellation result when durable tree close fails", async () => {
    const { pi, lifecycle } = makePi();
    const runtime = makeRuntime();
    vi.mocked(runtime.beforeTree).mockResolvedValue(false);
    registerPromptExtension(pi, { runtime, runEditor: vi.fn(async () => ({ kind: "exit" as const })) });
    const eventCtx = ctx();
    await expect(lifecycle.get("session_before_tree")({}, eventCtx)).resolves.toEqual({ cancel: true });
    expect(eventCtx.ui.notify).toHaveBeenCalledWith(
      "The active plan could not be closed safely. Tree navigation was cancelled; try again.", "error",
    );
  });

  it("moves shortcut text into the editor and preserves selected options on reopen", async () => {
    const { pi, commands, shortcuts } = makePi();
    const runtime = makeRuntime();
    const runEditor = vi.fn()
      .mockResolvedValueOnce({ kind: "generate", submission: { text: "first", mode: "careful", execution: { kind: "loop" }, selectedSkills: ["test-expert"], saveAsTemplate: false } })
      .mockResolvedValueOnce({ kind: "exit" })
      .mockResolvedValueOnce({ kind: "exit" });
    registerPromptExtension(pi, { runtime, runEditor });
    const commandCtx = ctx();
    await commands.get("prompt").handler("", commandCtx);
    expect(runtime.generate).toHaveBeenCalledWith(commandCtx, expect.objectContaining({ selectedSkills: ["test-expert"] }));
    await commands.get("prompt").handler("", commandCtx);
    expect(runEditor.mock.calls[1]?.[2]).toMatchObject({ mode: "careful", execution: { kind: "loop" }, selectedSkills: ["test-expert"] });

    const shortcutCtx = ctx("half-written");
    await shortcuts.get("ctrl+alt+p").handler(shortcutCtx as unknown as ExtensionContext);
    expect(shortcutCtx.ui.setEditorText).toHaveBeenCalledWith("");
    expect(runEditor.mock.calls[2]?.[2]).toMatchObject({ text: "half-written" });
  });

  it("wires public lifecycle events to close before tree and rescan afterward", async () => {
    const { pi, lifecycle } = makePi();
    const runtime = makeRuntime();
    registerPromptExtension(pi, { runtime, runEditor: vi.fn(async () => ({ kind: "exit" as const })) });
    const eventCtx = ctx();
    await lifecycle.get("session_before_tree")({}, eventCtx);
    lifecycle.get("session_tree")({}, eventCtx);
    lifecycle.get("session_start")({}, eventCtx);
    await lifecycle.get("session_shutdown")({}, eventCtx);
    expect(runtime.beforeTree).toHaveBeenCalledTimes(1);
    expect(runtime.sessionTree).toHaveBeenCalledWith(eventCtx);
    expect(runtime.sessionStart).toHaveBeenCalledWith(eventCtx);
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });
});
