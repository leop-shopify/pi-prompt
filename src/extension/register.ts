import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { saveDraft } from "../drafts.js";
import { memorizePromptTemplate } from "../prompt-templates.js";
import { dispatchDirectSend } from "../prompt-editor/direct-send.js";
import { chooseDraft, choosePromptTemplate, preloadPromptFile } from "../prompt-editor/sources.js";
import { runPromptEditor } from "../prompt-editor/tui.js";
import type { PromptEditorInitialState, PromptEditorOutcome } from "../prompt-editor/types.js";
import { captureSkills, safeNonce, skillBlocks } from "./pi-adapters.js";
import { CurrentAgentPlanBridge } from "./current-agent-bridge.js";
import { createControllerStackFactory } from "./controller-factory.js";
import { defaultBrowserPlanReviewPort } from "./browser-review-port.js";
import {
  createPromptExtensionRuntime, type PlanReviewPort, type PromptExtensionRuntime,
} from "./runtime.js";

export interface RegisterPromptExtensionOptions {
  readonly runtime?: PromptExtensionRuntime;
  readonly review?: PlanReviewPort;
  readonly runEditor?: typeof runPromptEditor;
  readonly bridge?: CurrentAgentPlanBridge;
}

export function registerPromptExtension(pi: ExtensionAPI, options: RegisterPromptExtensionOptions = {}): PromptExtensionRuntime {
  const editorRunner = options.runEditor ?? runPromptEditor;
  const bridge = options.bridge ?? new CurrentAgentPlanBridge(pi, { nonceFactory: safeNonce });
  let lastEditorOptions: PromptEditorInitialState = {};
  let runtime!: PromptExtensionRuntime;

  const open = async (ctx: ExtensionContext, initial: PromptEditorInitialState = {}): Promise<void> => {
    const merged: PromptEditorInitialState = {
      ...initial,
      mode: initial.mode ?? lastEditorOptions.mode,
      execution: initial.execution ?? lastEditorOptions.execution,
      selectedSkills: initial.selectedSkills ?? lastEditorOptions.selectedSkills,
    };
    const outcome = await editorRunner(pi, ctx, merged);
    await handleEditorOutcome(pi, ctx, outcome, runtime);
    if (outcome.kind === "generate" || outcome.kind === "direct-send") {
      lastEditorOptions = {
        mode: outcome.submission.mode,
        execution: outcome.submission.execution,
        selectedSkills: outcome.submission.selectedSkills,
      };
    }
  };

  runtime = options.runtime ?? createPromptExtensionRuntime({
    controllers: createControllerStackFactory(pi, bridge),
    review: options.review ?? defaultBrowserPlanReviewPort(pi, open),
    editor: { open },
  });

  registerPromptCommand(pi, "prompt", runtime, open);
  registerPromptCommand(pi, "pi-prompt", runtime, open);
  pi.registerShortcut("ctrl+alt+p", {
    description: "Move the current input into the fullscreen prompt editor",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify("prompt editor requires interactive mode", "error"); return; }
      await open(ctx, { text: takeEditorText(ctx) });
    },
  });

  pi.on("session_start", (_event, ctx) => runtime.sessionStart(ctx));
  pi.on("session_before_tree", async (_event, ctx) => {
    if (await runtime.beforeTree()) return;
    ctx.ui.notify("The active plan could not be closed safely. Tree navigation was cancelled; try again.", "error");
    return { cancel: true };
  });
  pi.on("session_tree", (_event, ctx) => runtime.sessionTree(ctx));
  pi.on("session_shutdown", async () => { await runtime.shutdown(); });
  return runtime;
}

function registerPromptCommand(
  pi: ExtensionAPI,
  name: "prompt" | "pi-prompt",
  runtime: PromptExtensionRuntime,
  open: (ctx: ExtensionContext, initial?: PromptEditorInitialState) => Promise<void>,
): void {
  pi.registerCommand(name, {
    description: "Open the fullscreen Plan prompt editor (file, drafts, goal-templates, loop-templates, or resume)",
    getArgumentCompletions: (prefix) => {
      const routes = [
        { value: "drafts", label: "drafts", description: "Open saved drafts" },
        { value: "goal-templates", label: "goal-templates", description: "Open goal prompt templates" },
        { value: "loop-templates", label: "loop-templates", description: "Open loop prompt templates" },
        { value: "resume", label: "resume", description: "Resume the newest saved plan on this branch" },
      ].filter((route) => route.value.startsWith(prefix));
      return routes.length > 0 ? routes : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { ctx.ui.notify(`/${name} requires interactive mode`, "error"); return; }
      await routePromptCommand(ctx, args.trim(), runtime, open);
    },
  });
}

async function routePromptCommand(
  ctx: ExtensionCommandContext,
  argument: string,
  runtime: PromptExtensionRuntime,
  open: (ctx: ExtensionContext, initial?: PromptEditorInitialState) => Promise<void>,
): Promise<void> {
  if (argument === "resume") { await runtime.resume(ctx); return; }
  if (argument === "drafts") { const initial = await chooseDraft(ctx); if (initial) await open(ctx, initial); return; }
  if (argument === "goal-templates" || argument === "loop-templates") {
    const initial = await choosePromptTemplate(ctx, argument === "goal-templates" ? "goal" : "loop");
    if (initial) await open(ctx, initial);
    return;
  }
  if (!argument) { await open(ctx); return; }
  const loaded = await preloadPromptFile(ctx.cwd, argument);
  if ("error" in loaded) { ctx.ui.notify(`Could not read ${argument}: ${loaded.error}`, "error"); return; }
  await open(ctx, { text: loaded.text, preloadedPath: loaded.path });
}

async function handleEditorOutcome(
  pi: ExtensionAPI, ctx: ExtensionContext, outcome: PromptEditorOutcome, runtime: PromptExtensionRuntime,
): Promise<void> {
  if (outcome.kind === "exit") return;
  if (outcome.kind === "stash") { if (outcome.text.length > 0) ctx.ui.setEditorText(outcome.text); return; }
  if (outcome.kind === "keep-draft") {
    await saveDraft(outcome.text, outcome.draftId);
    ctx.ui.notify("Draft saved. Reopen with /prompt drafts", "info");
    return;
  }
  const submission = outcome.submission;
  if (submission.saveAsTemplate) await persistTemplate(ctx, submission.text);
  if (outcome.kind === "generate") { await runtime.generate(ctx, submission); return; }
  const loaded = await captureSkills(pi, submission.selectedSkills);
  if (!loaded.ok) { ctx.ui.notify("Selected skill context is unavailable or changed.", "error"); return; }
  const dispatched = dispatchDirectSend({
    sendUserMessage: pi.sendUserMessage.bind(pi),
    setEditorText: ctx.ui.setEditorText.bind(ctx.ui),
    isIdle: ctx.isIdle.bind(ctx),
    notify: ctx.ui.notify.bind(ctx.ui),
  }, { text: submission.text, execution: submission.execution, skillBlocks: skillBlocks(loaded.value) });
  if (!dispatched.ok) ctx.ui.notify(dispatched.issues[0]?.message ?? "The prompt could not be sent.", "error");
}

async function persistTemplate(ctx: ExtensionContext, text: string): Promise<void> {
  try {
    const template = await memorizePromptTemplate(text);
    ctx.ui.notify(`Prompt template ${template.created ? "saved" : "already exists"} as ${template.name}.md`, "info");
  } catch {
    ctx.ui.notify("Could not save the prompt template.", "error");
  }
}

/** Read the main input and clear it before opening the fullscreen editor. */
export function takeEditorText(ctx: ExtensionContext): string {
  const text = ctx.ui.getEditorText();
  if (text.length > 0) ctx.ui.setEditorText("");
  return text;
}
