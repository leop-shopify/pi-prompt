import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { type Draft, draftPreview, listDrafts, saveDraft } from "./drafts.js";
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
}

const SHORTCUTS: Array<[string, string]> = [
  ["ctrl+enter", "send"],
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
  pi.registerCommand("prompt", {
    description: "Open a fullscreen markdown prompt editor (optionally preload a file, or `drafts`)",
    getArgumentCompletions: (prefix: string) => {
      if (prefix.length > 0 && "drafts".startsWith(prefix)) {
        return [{ value: "drafts", label: "drafts", description: "Open saved drafts" }];
      }
      return null;
    },
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/prompt requires interactive mode", "error");
        return;
      }

      const trimmed = args.trim();
      if (trimmed === "drafts") {
        await openDraftsBrowser(pi, ctx);
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

      await openEditor(pi, ctx, initialText, session);
    },
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Move the current input into the fullscreen prompt editor",
    handler: async (ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("prompt editor requires interactive mode", "error");
        return;
      }
      const moved = takeEditorText(ctx);
      await openEditor(pi, ctx, moved, {});
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
  | { kind: "submit"; text: string }
  | { kind: "exit" }
  | { kind: "keepDraft"; text: string }
  | { kind: "stash"; text: string };

async function openEditor(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  initialText: string,
  session: PromptSession,
): Promise<void> {
  const outcome = await runEditorOverlay(ctx, initialText, session);

  if (outcome.kind === "submit") {
    const text = outcome.text.trim();
    if (text.length === 0) {
      ctx.ui.notify("Empty prompt, nothing sent", "info");
      return;
    }
    // When the agent is mid-turn, queue the prompt as a follow-up so the send
    // does not throw and does not interrupt the running turn.
    if (ctx.isIdle()) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
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

function runEditorOverlay(
  ctx: ExtensionContext,
  initialText: string,
  session: PromptSession,
): Promise<EditorOutcome> {
  return ctx.ui.custom<EditorOutcome>((tui, theme, _keybindings, done) => {
    let mode: "edit" | "confirmExit" = "edit";
    let selectionInfo = "";

    const textarea = new TextArea(theme, {
      onChange: () => tui.requestRender(),
      onCopy: (chars) => {
        selectionInfo = `copied ${chars} chars`;
        tui.requestRender();
      },
      onSubmit: (text) => done({ kind: "submit", text }),
      onToggle: (text) => done({ kind: "stash", text }),
      onEscape: (hasText) => {
        if (!hasText) {
          done({ kind: "exit" });
          return;
        }
        mode = "confirmExit";
        tui.requestRender();
      },
    });
    textarea.setText(initialText);

    const title = session.preloadedPath ? `prompt — ${shortenPath(session.preloadedPath)}` : "prompt";

    const component: Component = {
      render(width: number): string[] {
        // The overlay is shown with margin:1 and maxHeight:"100%", so the
        // available height is terminal.rows - 2. Render exactly that many rows
        // so the frame fills the panel without being sliced by maxHeight.
        const height = Math.max(6, tui.terminal.rows - 2);
        const contentWidth = frameContentWidth(width);
        const bodyHeight = Math.max(1, height - frameChromeHeight(true));
        textarea.viewportHeight = bodyHeight;
        const body = textarea.render(contentWidth);

        const footer = mode === "confirmExit"
          ? buildExitFooter(theme)
          : buildEditFooter(theme, selectionInfo);

        return renderFrame({ width, height, theme, title, body, footer });
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
        textarea.handleInput(data);
        tui.requestRender();
      },
    };

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

async function openDraftsBrowser(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
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

  await openEditor(pi, ctx, draft.text, { draftId: draft.id });
}
