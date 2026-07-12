import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { TextArea } from "../textarea.js";
import { buildShortcutBar, frameChromeHeight, frameContentWidth, renderFrame, statusNote } from "../ui.js";
import { GENERATION_PROFILES } from "../plan/modes.js";
import { normalizeEditorSource } from "./sources.js";
import {
  EXECUTION_KIND_ORDER, PROMPT_PLANNING_MODE_ORDER, createPromptEditorState, cycleExecutionKind, cycleGenerationMode,
  generationModeHelp, promptFieldFocusForInput, skillSuggestions,
} from "./state.js";
import type { PromptEditorInitialState, PromptEditorOutcome, PromptEditorSubmission } from "./types.js";

const SHORTCUTS: Array<[string, string]> = [
  ["ctrl+enter", "primary action"], ["ctrl+shift+enter", "send without plan"], ["tab", "fields"],
  ["ctrl+alt+p", "back to input"], ["esc", "exit"], ["shift+arrows", "select"],
];
const EXIT_CHOICES = [
  { key: "k", label: "Keep as draft" }, { key: "d", label: "Discard" }, { key: "esc", label: "Keep editing" },
] as const;

export function runPromptEditor(
  pi: ExtensionAPI, ctx: ExtensionContext, initial: PromptEditorInitialState = {},
): Promise<PromptEditorOutcome> {
  return ctx.ui.custom<PromptEditorOutcome>((tui, theme, _keybindings, done) =>
    createPromptEditorComponent({ pi, tui, theme, initial, done }), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", minWidth: 40, margin: 1 },
    });
}

export interface PromptEditorComponentOptions {
  readonly pi: Pick<ExtensionAPI, "getCommands">;
  readonly tui: Pick<TUI, "terminal" | "requestRender">;
  readonly theme: Theme;
  readonly initial?: PromptEditorInitialState;
  readonly done: (outcome: PromptEditorOutcome) => void;
}

export function createPromptEditorComponent(options: PromptEditorComponentOptions): Component {
  const { pi, tui, theme, done } = options;
  const initial = options.initial ?? {};
  const state = createPromptEditorState(initial);
  const availableSkills = listSkillNames(pi);
  let overlayMode: "edit" | "confirm-exit" = "edit";
  let selectionInfo = "";

  const finish = (kind: "generate" | "direct-send"): void => {
    const normalized = normalizeEditorSource(textarea.getText(), state.execution);
    if (!normalized.ok) {
      selectionInfo = normalized.issues[0]?.message ?? "Execution kind conflicts with the typed prefix.";
      state.focus = "execution";
      tui.requestRender();
      return;
    }
    if (normalized.value.promptText.trim().length === 0) {
      selectionInfo = "Enter a prompt before continuing.";
      state.focus = "editor";
      tui.requestRender();
      return;
    }
    const submission: PromptEditorSubmission = {
      text: normalized.value.promptText,
      mode: state.mode === "no-plan" ? "normal" : state.mode,
      execution: normalized.value.execution,
      selectedSkills: [...state.selectedSkills],
      saveAsTemplate: state.saveAsTemplate,
    };
    done({ kind, submission });
  };

  const requestExit = (): void => {
    if (textarea.getText().trim().length === 0) { done({ kind: "exit" }); return; }
    overlayMode = "confirm-exit";
    tui.requestRender();
  };

  const primaryAction = (): void => finish(state.mode === "no-plan" ? "direct-send" : "generate");

  const textarea = new TextArea(theme, {
    onChange: () => tui.requestRender(),
    onCopy: (characters) => { selectionInfo = `copied ${characters} chars`; tui.requestRender(); },
    onSubmit: primaryAction,
    onToggle: (text) => done({ kind: "stash", text }),
    onEscape: requestExit,
  });
  textarea.setText(initial.text ?? "");

  const component: Component = {
    render(width: number): string[] {
      const height = Math.max(18, tui.terminal.rows - 2);
      const contentWidth = frameContentWidth(width);
      const modeHeight = 4;
      const executionHeight = 4;
      const skillsHeight = 3;
      const templateHeight = 3;
      const controlsHeight = modeHeight + executionHeight + skillsHeight + templateHeight;
      const editorHeight = Math.max(4, height - controlsHeight);
      textarea.focused = state.focus === "editor";
      textarea.viewportHeight = Math.max(1, editorHeight - frameChromeHeight(true));
      const title = initial.templateName
        ? `${initial.templateKind ?? "prompt"} template — ${initial.templateName}.md`
        : initial.preloadedPath ? `prompt — ${shortenPath(initial.preloadedPath)}` : "prompt";
      return [
        ...renderFrame({ width, height: modeHeight, theme, title: "generation depth", body: [
          renderModeChoices(theme, contentWidth, state.mode, state.focus === "mode"),
          truncateToWidth(generationModeHelp(state.mode), contentWidth, "…", false),
        ], color: state.focus === "mode" ? "accent" : "borderMuted" }),
        ...renderFrame({ width, height: executionHeight, theme, title: "execution", body: [
          renderExecutionChoices(theme, contentWidth, state.execution.kind, state.focus === "execution"),
          truncateToWidth(executionHelp(state.execution.kind), contentWidth, "…", false),
        ], color: state.focus === "execution" ? "accent" : "borderMuted" }),
        ...renderFrame({ width, height: editorHeight, theme, title, body: textarea.render(contentWidth),
          footer: overlayMode === "confirm-exit" ? buildExitFooter(theme) : buildEditFooter(theme, selectionInfo),
          color: state.focus === "editor" ? "accent" : "borderMuted" }),
        ...renderFrame({ width, height: skillsHeight, theme, title: "skills", body: [
          renderSkillValue(theme, contentWidth, state.selectedSkills, state.skillQuery, availableSkills, state.focus === "skills"),
        ], color: state.focus === "skills" ? "accent" : "borderMuted" }),
        ...renderFrame({ width, height: templateHeight, theme, title: "template", body: [
          renderSaveTemplate(theme, contentWidth, state.saveAsTemplate, state.focus === "saveAsTemplate"),
        ], color: state.focus === "saveAsTemplate" ? "accent" : "borderMuted" }),
      ];
    },
    invalidate(): void { textarea.invalidate(); },
    handleInput(data: string): void {
      if (overlayMode === "confirm-exit") { handleExitChoice(data); return; }
      selectionInfo = "";
      if (matchesKey(data, "ctrl+shift+enter") || matchesKey(data, "ctrl+shift+return")) { finish("direct-send"); return; }
      if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) { primaryAction(); return; }
      if (matchesKey(data, "ctrl+alt+p")) { done({ kind: "stash", text: textarea.getText() }); return; }
      if (matchesKey(data, "escape")) { requestExit(); return; }
      const focus = promptFieldFocusForInput(state.focus, data);
      if (focus) { state.focus = focus; tui.requestRender(); return; }
      if (state.focus === "mode") handleModeInput(data);
      else if (state.focus === "execution") handleExecutionInput(data);
      else if (state.focus === "skills") handleSkillInput(data);
      else if (state.focus === "saveAsTemplate") handleTemplateInput(data);
      else textarea.handleInput(data);
      tui.requestRender();
    },
  };

  function handleModeInput(data: string): void {
    if (matchesKey(data, "left")) state.mode = cycleGenerationMode(state.mode, -1);
    else if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "return")) state.mode = cycleGenerationMode(state.mode, 1);
  }
  function handleExecutionInput(data: string): void {
    if (matchesKey(data, "left")) state.execution = cycleExecutionKind(state.execution, -1);
    else if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "return")) state.execution = cycleExecutionKind(state.execution, 1);
  }
  function handleSkillInput(data: string): void {
    if (matchesKey(data, "left") || matchesKey(data, "right")) return;
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === ",") { acceptSkill(); return; }
    if (matchesKey(data, "backspace") || data === "\x7f") {
      if (state.skillQuery.length > 0) state.skillQuery = state.skillQuery.slice(0, -1);
      else state.selectedSkills.pop();
      return;
    }
    const character = decodeKittyPrintable(data) ?? data;
    if (isInlineText(character)) state.skillQuery += character;
  }
  function acceptSkill(): void {
    const query = state.skillQuery.trim();
    if (query.toLocaleLowerCase() === "none") state.selectedSkills.splice(0);
    else {
      const suggestions = skillSuggestions(availableSkills, query, state.selectedSkills);
      const exact = suggestions.find((skill) => skill.toLocaleLowerCase() === query.toLocaleLowerCase());
      const selected = exact ?? suggestions[0];
      if (selected) state.selectedSkills.push(selected);
    }
    state.skillQuery = "";
  }
  function handleTemplateInput(data: string): void {
    if (matchesKey(data, "left")) state.saveAsTemplate = false;
    else if (matchesKey(data, "right")) state.saveAsTemplate = true;
    else if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") state.saveAsTemplate = !state.saveAsTemplate;
  }
  function handleExitChoice(data: string): void {
    const character = (decodeKittyPrintable(data) ?? data).toLocaleLowerCase();
    if (character === "k") done({ kind: "keep-draft", text: textarea.getText(), ...(initial.draftId ? { draftId: initial.draftId } : {}) });
    else if (character === "d") done({ kind: "exit" });
    else if (matchesKey(data, "escape")) { overlayMode = "edit"; tui.requestRender(); }
  }
  return component;
}

function listSkillNames(pi: Pick<ExtensionAPI, "getCommands">): string[] {
  const names = new Set<string>();
  for (const command of pi.getCommands()) if (command.source === "skill") names.add(command.name.replace(/^skill:/, ""));
  return [...names].sort((left, right) => left.localeCompare(right));
}

function renderModeChoices(theme: Theme, width: number, selected: string, focused: boolean): string {
  return truncateToWidth(PROMPT_PLANNING_MODE_ORDER.map((mode) => {
    const label = mode === "no-plan" ? "No plan" : GENERATION_PROFILES[mode].label;
    const text = mode === selected ? `[${label}]` : ` ${label} `;
    return mode === selected ? theme.fg(focused ? "accent" : "muted", theme.bold(text)) : theme.fg("dim", text);
  }).join(theme.fg("dim", " ")), width, "…", false);
}
function renderExecutionChoices(theme: Theme, width: number, selected: string, focused: boolean): string {
  return truncateToWidth(EXECUTION_KIND_ORDER.map((kind) => {
    const label = kind === "normal" ? "Normal"
      : kind === "goal" ? "Goal (/goal)"
      : kind === "loop" ? "Loop (/loop)"
      : "Create Goal (/create-goal)";
    const text = kind === selected ? `[${label}]` : ` ${label} `;
    return kind === selected ? theme.fg(focused ? "accent" : "muted", theme.bold(text)) : theme.fg("dim", text);
  }).join(theme.fg("dim", " ")), width, "…", false);
}
function executionHelp(kind: (typeof EXECUTION_KIND_ORDER)[number]): string {
  if (kind === "goal") return "The ready plan remains persisted; final acceptance will stage one /goal prefix for human review.";
  if (kind === "loop") return "The ready plan remains persisted; final acceptance will stage one /loop prefix for human review.";
  if (kind === "create-goal") return "Stages one /create-goal prefix so pi-codex-goal can create a tracked goal from the accepted reviewed plan.";
  return "The ready plan remains persisted; final acceptance will stage plain text for human review.";
}
function renderSkillValue(theme: Theme, width: number, selected: readonly string[], query: string, available: readonly string[], focused: boolean): string {
  const chips = selected.length > 0 ? selected.map((skill) => theme.fg("accent", `@${skill}`)).join(" ") : focused ? "" : theme.fg("dim", "none");
  const hint = available.length === 0 ? "no skills available" : "type a skill, Enter/comma adds, none clears";
  const typed = focused ? `${query}█` : query;
  return truncateToWidth([chips, typed ? theme.fg(focused ? "warning" : "dim", typed) : theme.fg("dim", hint)].filter(Boolean).join(" "), width, "…", false);
}
function renderSaveTemplate(theme: Theme, width: number, enabled: boolean, focused: boolean): string {
  const label = `${enabled ? "[x]" : "[ ]"} save as template?`;
  const control = theme.fg(focused ? "accent" : "muted", theme.bold(label));
  return truncateToWidth(`${control}${theme.fg("dim", "  saves to ~/.pi/agent/prompt-templates/")}`, width, "…", false);
}
function buildEditFooter(theme: Theme, selectionInfo: string): string {
  const bar = buildShortcutBar(theme, SHORTCUTS);
  return selectionInfo ? `${bar}${theme.fg("dim", "   ")}${statusNote(theme, selectionInfo)}` : bar;
}
function buildExitFooter(theme: Theme): string {
  return theme.fg("warning", "Unsaved text — ") + EXIT_CHOICES.map((choice) =>
    `${theme.fg("accent", choice.key)} ${theme.fg("dim", choice.label)}`).join(theme.fg("dim", "  •  "));
}
function isInlineText(text: string): boolean {
  return text.length > 0 && [...text].every((character) => { const code = character.codePointAt(0)!; return code >= 32 && code !== 127 && character !== "\n" && character !== "\r"; });
}
function shortenPath(path: string): string { const parts = path.split("/"); return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`; }
