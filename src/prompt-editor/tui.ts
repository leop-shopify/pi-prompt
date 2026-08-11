import type { ExtensionAPI, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readClipboardPaste } from "./clipboard.js";
import { TextArea } from "../textarea.js";
import { buildShortcutBar, frameChromeHeight, frameContentWidth, renderFrame, statusNote } from "../ui.js";
import { GENERATION_PROFILES } from "../plan/modes.js";
import {
  PROMPT_PLANNING_MODE_ORDER, createPromptEditorState, cycleGenerationMode,
  generationModeHelp, promptFieldFocusForInput,
} from "./state.js";
import type { PromptEditorInitialState, PromptEditorOutcome, PromptEditorSubmission } from "./types.js";

const SHORTCUTS: Array<[string, string]> = [
  ["ctrl+enter", "primary action"], ["ctrl+shift+enter", "send without plan"], ["tab/shift+tab", "navigate"],
  ["ctrl+alt+p", "back to input"], ["esc", "exit"], ["shift+arrows", "select"],
];
const EXIT_CHOICES = [
  { key: "k", label: "Keep as draft" }, { key: "d", label: "Discard" }, { key: "esc", label: "Keep editing" },
] as const;

export function runPromptEditor(
  _pi: ExtensionAPI, ctx: ExtensionContext, initial: PromptEditorInitialState = {},
): Promise<PromptEditorOutcome> {
  return ctx.ui.custom<PromptEditorOutcome>((tui, theme, keybindings, done) =>
    createPromptEditorComponent({ tui, theme, keybindings, initial, done, returnToInput: ctx.ui.setEditorText.bind(ctx.ui) }), {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", minWidth: 40, margin: 1 },
    });
}

export interface PromptEditorComponentOptions {
  readonly tui: Pick<TUI, "terminal" | "requestRender">;
  readonly theme: Theme;
  readonly keybindings: Pick<KeybindingsManager, "matches">;
  readonly initial?: PromptEditorInitialState;
  readonly done: (outcome: PromptEditorOutcome) => void;
  readonly returnToInput: (text: string) => void;
  readonly readClipboardPaste?: () => Promise<string | null>;
}

export function createPromptEditorComponent(options: PromptEditorComponentOptions): Component {
  const { tui, theme, keybindings, done, returnToInput } = options;
  const initial = options.initial ?? {};
  const pasteFromClipboard = options.readClipboardPaste ?? readClipboardPaste;
  const state = createPromptEditorState(initial);
  let overlayMode: "edit" | "confirm-exit" = "edit";
  let selectionInfo = "";
  let active = true;

  const finish = (kind: "generate" | "direct-send"): void => {
    const text = textarea.getText();
    if (text.trim().length === 0) {
      selectionInfo = "Enter a prompt before continuing.";
      state.focus = "editor";
      tui.requestRender();
      return;
    }
    const submission: PromptEditorSubmission = {
      text,
      mode: state.mode === "no-plan" ? "normal" : state.mode,
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
    onToggle: moveToInput,
    onEscape: requestExit,
  });
  textarea.setText(initial.text ?? "");

  const component: Component & { dispose(): void } = {
    render(width: number): string[] {
      const height = Math.max(18, tui.terminal.rows - 2);
      const contentWidth = frameContentWidth(width);
      const modeHeight = 4;
      const templateHeight = 3;
      const controlsHeight = modeHeight + templateHeight;
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
        ...renderFrame({ width, height: editorHeight, theme, title, body: textarea.render(contentWidth),
          footer: overlayMode === "confirm-exit" ? buildExitFooter(theme) : buildEditFooter(theme, selectionInfo),
          color: state.focus === "editor" ? "accent" : "borderMuted" }),
        ...renderFrame({ width, height: templateHeight, theme, title: "template", body: [
          renderSaveTemplate(theme, contentWidth, state.saveAsTemplate, state.focus === "saveAsTemplate"),
        ], color: state.focus === "saveAsTemplate" ? "accent" : "borderMuted" }),
      ];
    },
    invalidate(): void { textarea.invalidate(); },
    dispose(): void { active = false; },
    handleInput(data: string): void {
      if (overlayMode === "confirm-exit") { handleExitChoice(data); return; }
      selectionInfo = "";
      if (keybindings.matches(data, "app.clipboard.pasteImage")) {
        state.focus = "editor";
        tui.requestRender();
        void pasteFromClipboard().then((text) => {
          if (!active || !text) return;
          textarea.handleInput(`\x1b[200~${text}\x1b[201~`);
        }).catch(() => undefined);
        return;
      }
      if (matchesKey(data, "ctrl+shift+enter") || matchesKey(data, "ctrl+shift+return")) { finish("direct-send"); return; }
      if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) { primaryAction(); return; }
      if (matchesKey(data, "ctrl+alt+p")) { moveToInput(textarea.getText()); return; }
      if (matchesKey(data, "escape")) { requestExit(); return; }
      const focus = promptFieldFocusForInput(state.focus, data);
      if (focus) { state.focus = focus; tui.requestRender(); return; }
      if (state.focus === "mode") handleModeInput(data);
      else if (state.focus === "saveAsTemplate") handleTemplateInput(data);
      else textarea.handleInput(data);
      tui.requestRender();
    },
  };

  function moveToInput(text: string): void {
    returnToInput(text);
    done({ kind: "exit" });
  }
  function handleModeInput(data: string): void {
    if (matchesKey(data, "left")) state.mode = cycleGenerationMode(state.mode, -1);
    else if (matchesKey(data, "right") || matchesKey(data, "enter") || matchesKey(data, "return")) state.mode = cycleGenerationMode(state.mode, 1);
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

function renderModeChoices(theme: Theme, width: number, selected: string, focused: boolean): string {
  return truncateToWidth(PROMPT_PLANNING_MODE_ORDER.map((mode) => {
    const label = mode === "no-plan" ? "No plan" : GENERATION_PROFILES[mode].label;
    const text = mode === selected ? `[${label}]` : ` ${label} `;
    return mode === selected ? theme.fg(focused ? "accent" : "muted", theme.bold(text)) : theme.fg("dim", text);
  }).join(theme.fg("dim", " ")), width, "…", false);
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
function shortenPath(path: string): string { const parts = path.split("/"); return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`; }
