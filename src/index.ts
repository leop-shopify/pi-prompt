import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type Draft, draftPreview, listDrafts, saveDraft } from "./drafts.js";
import { listPromptTemplates, memorizePromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import {
  createPromptBuildFlow,
  MULTIPLIER_CHOICES,
  multiplierValue,
  type MultiplierChoice,
  renderMultiplierChoice,
  skillSuggestions,
} from "./prompt-build.js";
import { TextArea } from "./textarea.js";
import {
  buildShortcutBar,
  frameChromeHeight,
  frameContentWidth,
  renderFrame,
  statusNote,
} from "./ui.js";

interface PromptSession {
  draftId?: string;
  preloadedPath?: string;
  templateName?: string;
}

interface PromptSubmitOptions {
  multiplier: number | null;
  skills: string[];
  saveAsTemplate: boolean;
}

interface SkillCommandInfo {
  name: string;
  source?: string;
  sourceInfo?: {
    path?: string;
    baseDir?: string;
  };
}

export type PromptFieldFocus = "multiplier" | "editor" | "skills" | "saveAsTemplate";

const PROMPT_FIELD_FOCUS_ORDER: PromptFieldFocus[] = ["multiplier", "editor", "skills", "saveAsTemplate"];

const SHORTCUTS: Array<[string, string]> = [
  ["ctrl+enter", "send"],
  ["tab / shift+tab", "fields"],
  ["ctrl+alt+p", "back to input"],
  ["esc", "exit"],
  ["shift+arrows", "select"],
  ["ctrl+c", "copy"],
  ["ctrl+x", "cut"],
  ["ctrl+z", "undo"],
];

const EXIT_CHOICES = [
  { key: "k", label: "Keep as draft" },
  { key: "d", label: "Discard" },
  { key: "esc", label: "Keep editing" },
] as const;


async function tryReadFile(cwd: string, rawPath: string): Promise<{ path: string; text: string } | { error: string }> {
  const cleaned = rawPath.trim().replace(/^@/, "");
  const path = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
  try {
    const text = await readFile(path, "utf8");
    return { path, text };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: reason };
  }
}

export default function (pi: ExtensionAPI) {
  let promptBuild!: ReturnType<typeof createPromptBuildFlow>;
  promptBuild = createPromptBuildFlow(pi, {
    openPromptEditor: async (ctx, finalPrompt) => {
      await openEditor(pi, ctx, finalPrompt, {}, promptBuild);
    },
  });

  registerPromptCommand(pi, "prompt", promptBuild);
  registerPromptCommand(pi, "pi-prompt", promptBuild);

  pi.events?.on?.("pi-extended-teams:agent-report", (event: unknown) => {
    void promptBuild.handleAgentReport(event);
  });
  pi.events?.on?.("pi-prompt:prompt-build:progress", (event: unknown) => {
    promptBuild.handleProgress(event);
  });
  pi.events?.on?.("pi-prompt:prompt-build:error", (event: unknown) => {
    promptBuild.handleError(event);
  });

  pi.on("session_shutdown", async () => {
    promptBuild.shutdown();
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Move the current input into the fullscreen prompt editor",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("prompt editor requires interactive mode", "error");
        return;
      }
      const moved = takeEditorText(ctx);
      await openEditor(pi, ctx, moved, {}, promptBuild);
    },
  });
}

function registerPromptCommand(pi: ExtensionAPI, name: "prompt" | "pi-prompt", promptBuild: ReturnType<typeof createPromptBuildFlow>): void {
  pi.registerCommand(name, {
    description: "Open a fullscreen markdown prompt editor (optionally preload a file, `drafts`, or `templates`)",
    getArgumentCompletions: (prefix: string) => {
      const completions = [
        { value: "drafts", label: "drafts", description: "Open saved drafts" },
        { value: "templates", label: "templates", description: "Open saved prompt templates" },
        { value: "resume", label: "resume", description: "Resume paused prompt-build review" },
      ].filter((item) => item.value.startsWith(prefix));
      return completions.length > 0 ? completions : null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${name} requires interactive mode`, "error");
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "drafts") {
        await openDraftsBrowser(pi, ctx, promptBuild);
        return;
      }
      if (trimmed === "templates") {
        await openPromptTemplatesBrowser(pi, ctx, promptBuild);
        return;
      }
      if (trimmed === "resume") {
        await promptBuild.resume(ctx);
        return;
      }

      const session: PromptSession = {};
      let initialText = "";

      if (trimmed.length > 0) {
        const result = await tryReadFile(ctx.cwd, trimmed);
        if ("error" in result) {
          ctx.ui.notify(`Could not read ${trimmed}: ${result.error}`, "error");
          return;
        }
        initialText = result.text;
        session.preloadedPath = result.path;
      }

      await openEditor(pi, ctx, initialText, session, promptBuild);
    },
  });
}

/** Read the core input text and clear it, returning what was there. */
export function takeEditorText(ctx: ExtensionContext): string {
  const text = ctx.ui.getEditorText();
  if (text.length > 0) ctx.ui.setEditorText("");
  return text;
}

type EditorOutcome =
  | { kind: "submit"; text: string; options: PromptSubmitOptions }
  | { kind: "exit" }
  | { kind: "keepDraft"; text: string }
  | { kind: "stash"; text: string };

async function openEditor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialText: string,
  session: PromptSession,
  promptBuild: ReturnType<typeof createPromptBuildFlow>,
): Promise<void> {
  const outcome = await runEditorOverlay(pi, ctx, initialText, session);

  if (outcome.kind === "submit") {
    const text = outcome.text.trim();
    if (text.length === 0) {
      ctx.ui.notify("Empty prompt, nothing sent", "info");
      return;
    }

    if (outcome.options.saveAsTemplate) {
      await persistPromptTemplate(ctx, text);
    }

    const skillContext = await buildSelectedSkillBlocks(pi, outcome.options.skills);

    if (outcome.options.multiplier !== null) {
      await promptBuild.start(ctx, text, outcome.options.multiplier, skillContext);
      return;
    }

    const message = buildDirectPromptMessage(text, skillContext);
    // When the agent is mid-turn, queue the prompt as a follow-up so the send
    // does not throw and does not interrupt the running turn.
    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
    } else {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify("Agent is busy — prompt queued as follow-up", "info");
    }
    return;
  }

  if (outcome.kind === "keepDraft") {
    await saveDraft(outcome.text, session.draftId);
    ctx.ui.notify("Draft saved. Reopen with /prompt drafts", "info");
    return;
  }

  if (outcome.kind === "stash") {
    if (outcome.text.length > 0) ctx.ui.setEditorText(outcome.text);
    return;
  }
}

async function persistPromptTemplate(ctx: ExtensionContext, text: string): Promise<void> {
  try {
    const template = await memorizePromptTemplate(text);
    const status = template.created ? "saved" : "already exists";
    ctx.ui.notify(`Prompt template ${status} as ${template.name}.md`, "info");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Could not save prompt template: ${reason}`, "error");
  }
}

function runEditorOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialText: string,
  session: PromptSession,
): Promise<EditorOutcome> {
  return ctx.ui.custom<EditorOutcome>((tui, theme, _keybindings, done) => {
    let mode: "edit" | "confirmExit" = "edit";
    let focus: PromptFieldFocus = "editor";
    let selectionInfo = "";
    let multiplierIndex = 0;
    let customMultiplier = "";
    let skillQuery = "";
    let skillSuggestionIndex = 0;
    let saveAsTemplate = false;
    const selectedSkills: string[] = [];
    const availableSkills = listSkillCommands(pi).map((skill) => skill.name);

    const submit = (text: string) => {
      const multiplier = multiplierValue(MULTIPLIER_CHOICES[multiplierIndex]!, customMultiplier);
      if (MULTIPLIER_CHOICES[multiplierIndex] !== "none" && multiplier === null) {
        selectionInfo = "type a positive multiplier number";
        focus = "multiplier";
        tui.requestRender();
        return;
      }
      done({
        kind: "submit",
        text,
        options: { multiplier, skills: [...selectedSkills], saveAsTemplate },
      });
    };

    const requestExit = (hasText: boolean) => {
      if (!hasText) {
        done({ kind: "exit" });
        return;
      }
      mode = "confirmExit";
      tui.requestRender();
    };

    const textarea = new TextArea(theme, {
      onChange: () => tui.requestRender(),
      onCopy: (chars) => {
        selectionInfo = `copied ${chars} chars`;
        tui.requestRender();
      },
      onSubmit: submit,
      onToggle: (text) => done({ kind: "stash", text }),
      onEscape: requestExit,
    });
    textarea.setText(initialText);

    const title = session.templateName
      ? `prompt template — ${session.templateName}.md`
      : session.preloadedPath ? `prompt — ${shortenPath(session.preloadedPath)}` : "prompt";

    const component: Component = {
      render(width: number): string[] {
        // The overlay is shown with margin:1 and maxHeight:"100%", so the
        // available height is terminal.rows - 2. Render exactly that many rows
        // so the panel fills the available space without being sliced.
        const height = Math.max(10, tui.terminal.rows - 2);
        const contentWidth = frameContentWidth(width);
        const controlFrameHeight = 3;
        const controlFrameCount = 3;
        const promptHeight = Math.max(4, height - controlFrameHeight * controlFrameCount);
        const footer = mode === "confirmExit"
          ? buildExitFooter(theme)
          : buildEditFooter(theme, selectionInfo);
        textarea.focused = focus === "editor";
        textarea.viewportHeight = Math.max(1, promptHeight - frameChromeHeight(true));

        return [
          ...renderFrame({
            width,
            height: controlFrameHeight,
            theme,
            title: "multiplier factor",
            body: [renderMultiplierValue(theme, contentWidth, MULTIPLIER_CHOICES[multiplierIndex]!, customMultiplier, focus === "multiplier")],
            color: focus === "multiplier" ? "accent" : "borderMuted",
          }),
          ...renderFrame({
            width,
            height: promptHeight,
            theme,
            title,
            body: textarea.render(contentWidth),
            footer,
            color: focus === "editor" ? "accent" : "borderMuted",
          }),
          ...renderFrame({
            width,
            height: controlFrameHeight,
            theme,
            title: "use skill",
            body: [renderSkillValue(theme, contentWidth, selectedSkills, skillQuery, availableSkills, skillSuggestionIndex, focus === "skills")],
            color: focus === "skills" ? "accent" : "borderMuted",
          }),
          ...renderFrame({
            width,
            height: controlFrameHeight,
            theme,
            title: "template",
            body: [renderSaveAsTemplateValue(theme, contentWidth, saveAsTemplate, focus === "saveAsTemplate")],
            color: focus === "saveAsTemplate" ? "accent" : "borderMuted",
          }),
        ];
      },
      invalidate(): void {
        textarea.invalidate();
      },
      handleInput(data: string): void {
        if (mode === "confirmExit") {
          handleExitChoice(data);
          return;
        }
        selectionInfo = "";

        if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) {
          submit(textarea.getText());
          return;
        }
        if (matchesKey(data, "ctrl+alt+p")) {
          done({ kind: "stash", text: textarea.getText() });
          return;
        }
        if (matchesKey(data, "escape")) {
          requestExit(textarea.getText().trim().length > 0);
          return;
        }

        const nextFocus = promptFieldFocusForInput(focus, data);
        if (nextFocus) {
          focus = nextFocus;
          tui.requestRender();
          return;
        }

        if (focus === "multiplier") {
          handleMultiplierInput(data);
          tui.requestRender();
          return;
        }
        if (focus === "skills") {
          handleSkillInput(data);
          tui.requestRender();
          return;
        }
        if (focus === "saveAsTemplate") {
          handleSaveAsTemplateInput(data);
          tui.requestRender();
          return;
        }

        textarea.handleInput(data);
        tui.requestRender();
      },
    };

    function handleMultiplierInput(data: string): void {
      if (matchesKey(data, "left")) {
        multiplierIndex = (multiplierIndex - 1 + MULTIPLIER_CHOICES.length) % MULTIPLIER_CHOICES.length;
        return;
      }
      if (matchesKey(data, "right")) {
        multiplierIndex = (multiplierIndex + 1) % MULTIPLIER_CHOICES.length;
        return;
      }
      if (MULTIPLIER_CHOICES[multiplierIndex] !== "custom") return;
      if (matchesKey(data, "backspace") || data === "\x7f") {
        customMultiplier = customMultiplier.slice(0, -1);
        return;
      }
      const ch = decodeKittyPrintable(data) ?? data;
      if (/^[0-9]$/.test(ch)) customMultiplier += ch;
    }

    function handleSkillInput(data: string): void {
      if (matchesKey(data, "left") || matchesKey(data, "right")) return;
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        acceptCurrentSkillSuggestion();
        return;
      }
      if (matchesKey(data, "backspace") || data === "\x7f") {
        if (skillQuery.length > 0) skillQuery = skillQuery.slice(0, -1);
        else selectedSkills.pop();
        skillSuggestionIndex = 0;
        return;
      }
      const ch = decodeKittyPrintable(data) ?? data;
      if (ch === ",") {
        acceptCurrentSkillSuggestion();
        return;
      }
      if (isInlineText(ch)) {
        skillQuery += ch;
        skillSuggestionIndex = 0;
      }
    }

    function handleSaveAsTemplateInput(data: string): void {
      if (matchesKey(data, "left")) {
        saveAsTemplate = false;
        return;
      }
      if (matchesKey(data, "right")) {
        saveAsTemplate = true;
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        saveAsTemplate = !saveAsTemplate;
        return;
      }
      const ch = decodeKittyPrintable(data) ?? data;
      if (ch === " ") saveAsTemplate = !saveAsTemplate;
    }

    function currentSkillSuggestions(): string[] {
      return skillSuggestions(availableSkills, skillQuery, selectedSkills);
    }

    function acceptCurrentSkillSuggestion(): void {
      const query = skillQuery.trim();
      if (query.toLowerCase() === "none") {
        selectedSkills.splice(0, selectedSkills.length);
        skillQuery = "";
        skillSuggestionIndex = 0;
        return;
      }
      const suggestions = currentSkillSuggestions();
      const exact = suggestions.find((skill) => skill.toLowerCase() === query.toLowerCase());
      const chosen = exact ?? suggestions[0] ?? query;
      if (chosen && availableSkills.includes(chosen) && !selectedSkills.includes(chosen)) selectedSkills.push(chosen);
      skillQuery = "";
      skillSuggestionIndex = 0;
    }

    function handleExitChoice(data: string): void {
      const ch = (decodeKittyPrintable(data) ?? data).toLowerCase();
      if (ch === "k") {
        done({ kind: "keepDraft", text: textarea.getText() });
        return;
      }
      if (ch === "d") {
        done({ kind: "exit" });
        return;
      }
      if (matchesKey(data, "escape")) {
        mode = "edit";
        tui.requestRender();
      }
    }

    return component;
  }, {
    overlay: true,
    overlayOptions: {
      anchor: "center",
      width: "100%",
      maxHeight: "100%",
      minWidth: 40,
      margin: 1,
    },
  });
}

export function promptFieldFocusForInput(
  current: PromptFieldFocus,
  data: string,
  includeSaveAsTemplate = true,
): PromptFieldFocus | null {
  if (matchesKey(data, "shift+tab")) return movePromptFieldFocus(current, -1, includeSaveAsTemplate);
  if (matchesKey(data, "tab")) return movePromptFieldFocus(current, 1, includeSaveAsTemplate);
  return null;
}

function movePromptFieldFocus(current: PromptFieldFocus, direction: -1 | 1, includeSaveAsTemplate: boolean): PromptFieldFocus {
  const focusOrder = includeSaveAsTemplate
    ? PROMPT_FIELD_FOCUS_ORDER
    : PROMPT_FIELD_FOCUS_ORDER.filter((field) => field !== "saveAsTemplate");
  const index = focusOrder.indexOf(current);
  const safeIndex = index >= 0 ? index : 0;
  const nextIndex = (safeIndex + direction + focusOrder.length) % focusOrder.length;
  return focusOrder[nextIndex]!;
}

function listSkillCommands(pi: ExtensionAPI): SkillCommandInfo[] {
  const getCommands = (pi as unknown as { getCommands?: () => SkillCommandInfo[] }).getCommands;
  const commands = typeof getCommands === "function" ? getCommands.call(pi) : [];
  const byName = new Map<string, SkillCommandInfo>();

  for (const command of commands) {
    if (command.source !== "skill" || typeof command.name !== "string") continue;
    const name = command.name.replace(/^skill:/, "");
    if (!byName.has(name)) byName.set(name, { ...command, name });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function buildSelectedSkillBlocks(pi: ExtensionAPI, selectedSkillNames: string[]): Promise<string> {
  if (selectedSkillNames.length === 0) return "";

  const commandsByName = new Map(listSkillCommands(pi).map((command) => [command.name, command]));
  const blocks: string[] = [];

  for (const name of [...new Set(selectedSkillNames)]) {
    const command = commandsByName.get(name);
    const skillPath = command?.sourceInfo?.path;
    if (!skillPath) continue;

    try {
      const content = await readFile(skillPath, "utf8");
      blocks.push([
        `<skill name="${escapeXmlAttribute(name)}" location="${escapeXmlAttribute(skillPath)}">`,
        `References are relative to ${command.sourceInfo?.baseDir ?? skillPath}.`,
        "",
        content.trim(),
        "</skill>",
      ].join("\n"));
    } catch {
      // A stale command entry should not block sending the prompt.
    }
  }

  return blocks.join("\n\n");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isInlineText(text: string): boolean {
  if (text.length === 0) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || cp === 127 || ch === "\n" || ch === "\r") return false;
  }
  return true;
}

function renderMultiplierValue(
  theme: Theme,
  width: number,
  choice: MultiplierChoice,
  customValue: string,
  focused: boolean,
): string {
  const cells = MULTIPLIER_CHOICES.map((candidate) => {
    const label = candidate === "custom" ? renderMultiplierChoice(candidate, customValue) : renderMultiplierChoice(candidate, "");
    const text = candidate === choice
      ? candidate === "custom" ? label : `[${label}]`
      : ` ${label} `;
    if (candidate !== choice) return theme.fg("dim", text);
    return focused ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", theme.bold(text));
  }).join(theme.fg("dim", " "));
  return truncateToWidth(cells, width, "…", false);
}

function renderSkillValue(
  theme: Theme,
  width: number,
  selected: string[],
  query: string,
  available: string[],
  _suggestionIndex: number,
  focused: boolean,
): string {
  const chips = selected.length > 0
    ? selected.map((skill) => theme.fg("accent", `@${skill}`)).join(" ")
    : focused ? "" : theme.fg("dim", "none");
  const hint = available.length === 0 ? "no skills available" : "type skill name, enter/comma to add, type none to clear";
  const typed = focused ? `${query}█` : query;
  const queryText = typed.length > 0 ? theme.fg(focused ? "warning" : "dim", typed) : theme.fg("dim", hint);
  const separator = chips && queryText ? " " : "";
  return truncateToWidth(`${chips}${separator}${queryText}`, width, "…", false);
}

function renderSaveAsTemplateValue(theme: Theme, width: number, enabled: boolean, focused: boolean): string {
  const checkbox = enabled ? "[x]" : "[ ]";
  const label = `${checkbox} save as template?`;
  const control = focused ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", theme.bold(label));
  const hint = theme.fg("dim", "  saves to ~/.pi/agent/prompt-templates/ on send");
  return truncateToWidth(`${control}${hint}`, width, "…", false);
}

function buildDirectPromptMessage(text: string, skillContext: string): string {
  if (skillContext.trim().length === 0) return text;
  return [skillContext.trim(), "", "User prompt:", text].join("\n");
}

function buildEditFooter(theme: Theme, selectionInfo: string): string {
  const bar = buildShortcutBar(theme, SHORTCUTS);
  if (!selectionInfo) return bar;
  return `${bar}${theme.fg("dim", "   ")}${statusNote(theme, selectionInfo)}`;
}

function buildExitFooter(theme: Theme): string {
  const prompt = theme.fg("warning", "Unsaved text — ");
  const choices = EXIT_CHOICES.map(
    (choice) => `${theme.fg("accent", choice.key)} ${theme.fg("dim", choice.label)}`,
  ).join(theme.fg("dim", "  •  "));
  return prompt + choices;
}

function shortenPath(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

async function openDraftsBrowser(pi: ExtensionAPI, ctx: ExtensionCommandContext, promptBuild: ReturnType<typeof createPromptBuildFlow>): Promise<void> {
  const drafts = await listDrafts();
  if (drafts.length === 0) {
    ctx.ui.notify("No saved drafts", "info");
    return;
  }

  const labels = drafts.map((draft, i) => {
    const when = new Date(draft.updatedAt).toLocaleString();
    return `${i + 1}. ${draftPreview(draft)}  (${when})`;
  });

  const chosenLabel = await ctx.ui.select("Open a draft", labels);
  if (!chosenLabel) return;

  const index = labels.indexOf(chosenLabel);
  const draft = index >= 0 ? drafts[index] : undefined;
  if (!draft) return;

  await openEditor(pi, ctx, draft.text, { draftId: draft.id }, promptBuild);
}

async function openPromptTemplatesBrowser(pi: ExtensionAPI, ctx: ExtensionCommandContext, promptBuild: ReturnType<typeof createPromptBuildFlow>): Promise<void> {
  const templates = await listPromptTemplates();
  if (templates.length === 0) {
    ctx.ui.notify("No saved prompt templates", "info");
    return;
  }

  const labels = templates.map(promptTemplateLabel);
  const chosenLabel = await ctx.ui.select("Open a prompt template", labels);
  if (!chosenLabel) return;

  const index = labels.indexOf(chosenLabel);
  const template = index >= 0 ? templates[index] : undefined;
  if (!template) return;

  await openEditor(pi, ctx, template.text, { preloadedPath: template.path, templateName: template.name }, promptBuild);
}

function promptTemplateLabel(template: PromptTemplate): string {
  const source = template.source === "extension" ? "extension" : "saved";
  return `${template.title}  (${source}: ${template.name}.md)`;
}
