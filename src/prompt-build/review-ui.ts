import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { assembleFinalPrompt, decisionRecord, selectedOptionsInOrder } from "./assembly.js";
import { parseAllPromptOptions } from "./parser.js";
import type {
  ParsedPromptOption,
  PromptBranchResult,
  PromptBuildReviewResult,
  PromptBuildReviewSnapshot,
  PromptBuildReviewState,
  PromptBuildSessionFiles,
  PromptOptionDecision,
} from "./types.js";
import { frameChromeHeight, frameContentWidth, renderFrame } from "../ui.js";

export interface BranchOptionGroup {
  branchIndex: number;
  title: string;
  options: ParsedPromptOption[];
  error?: string;
}

export function createPromptBuildReviewState(): PromptBuildReviewState {
  return {
    branchCursor: 0,
    optionCursor: 0,
    phase: "review",
    decisions: new Map(),
    ignoredBranches: new Set(),
  };
}

export function snapshotReviewState(state: PromptBuildReviewState): PromptBuildReviewSnapshot {
  return {
    phase: state.phase,
    branchCursor: state.branchCursor,
    optionCursor: state.optionCursor,
    decisions: decisionRecord(state.decisions),
    ignoredBranches: [...state.ignoredBranches].sort((a, b) => a - b),
  };
}

export function runPromptQuestionnaire(
  ctx: ExtensionContext,
  originalPrompt: string,
  branches: PromptBranchResult[],
  session: PromptBuildSessionFiles,
  _skillContext: string,
  state: PromptBuildReviewState = createPromptBuildReviewState(),
  onStateChange?: (snapshot: PromptBuildReviewSnapshot, selectedOptions: ParsedPromptOption[]) => void,
): Promise<PromptBuildReviewResult | null> {
  const options = parseAllPromptOptions(branches);
  const groups = buildBranchGroups(branches, options);

  return ctx.ui.custom<PromptBuildReviewResult | null>((tui, theme, _keybindings, done) => {
    const notifyStateChanged = () => {
      onStateChange?.(snapshotReviewState(state), selectedOptionsInOrder(options, state.decisions));
    };

    const currentGroup = () => groups[state.branchCursor];
    const currentOption = () => currentGroup()?.options[state.optionCursor];

    const clampCursor = () => {
      if (groups.length === 0) {
        state.branchCursor = 0;
        state.optionCursor = 0;
        return;
      }
      state.branchCursor = Math.min(Math.max(0, state.branchCursor), groups.length - 1);
      const rowCount = (currentGroup()?.options.length ?? 0) + 1;
      state.optionCursor = Math.min(Math.max(0, state.optionCursor), Math.max(0, rowCount - 1));
    };

    const setDecision = (option: ParsedPromptOption | undefined, decision: PromptOptionDecision) => {
      if (!option) return;
      if (decision === "undecided") state.decisions.delete(option.id);
      else state.decisions.set(option.id, decision);
    };

    const branchIgnored = (group: BranchOptionGroup | undefined) => {
      if (!group) return false;
      if (group.options.length === 0) return state.ignoredBranches.has(group.branchIndex);
      return group.options.every((option) => decisionFor(state, option) === "ignored");
    };

    const branchHasSelected = (group: BranchOptionGroup | undefined) => {
      return Boolean(group?.options.some((option) => decisionFor(state, option) === "selected"));
    };

    const branchDecided = (group: BranchOptionGroup | undefined) => {
      return branchHasSelected(group) || branchIgnored(group);
    };

    const toggleCurrentRow = () => {
      const group = currentGroup();
      if (!group) return;
      const ignoreRow = state.optionCursor >= group.options.length;

      if (ignoreRow) {
        if (group.options.length === 0) {
          if (state.ignoredBranches.has(group.branchIndex)) state.ignoredBranches.delete(group.branchIndex);
          else state.ignoredBranches.add(group.branchIndex);
        } else {
          const nextDecision: PromptOptionDecision = branchIgnored(group) ? "undecided" : "ignored";
          for (const option of group.options) setDecision(option, nextDecision);
        }
        notifyStateChanged();
        return;
      }

      state.ignoredBranches.delete(group.branchIndex);
      const option = currentOption();
      const current = option ? decisionFor(state, option) : "undecided";
      // Selecting a concrete path means this branch is no longer fully ignored.
      if (current !== "selected") {
        for (const branchOption of group.options) {
          if (decisionFor(state, branchOption) === "ignored") setDecision(branchOption, "undecided");
        }
      }
      setDecision(option, current === "selected" ? "undecided" : "selected");
      notifyStateChanged();
    };

    const moveBranch = (direction: -1 | 1) => {
      if (groups.length === 0) return;
      state.branchCursor = Math.min(Math.max(0, state.branchCursor + direction), groups.length - 1);
      const rowCount = (currentGroup()?.options.length ?? 0) + 1;
      state.optionCursor = Math.min(state.optionCursor, Math.max(0, rowCount - 1));
    };

    const jumpToFirstUndecidedBranch = () => {
      const index = groups.findIndex((group) => !branchDecided(group));
      if (index >= 0) {
        state.branchCursor = index;
        state.optionCursor = 0;
      }
      return index;
    };

    const finish = () => {
      const undecidedIndex = jumpToFirstUndecidedBranch();
      if (undecidedIndex >= 0) {
        ctx.ui.notify("Choose at least one option or 'do not apply' for every branch", "warning");
        notifyStateChanged();
        tui.requestRender();
        return;
      }

      const selectedOptions = selectedOptionsInOrder(options, state.decisions);
      if (selectedOptions.length === 0) {
        ctx.ui.notify("Select at least one prompt path before rebuilding the prompt screen", "warning");
        tui.requestRender();
        return;
      }

      const finalPrompt = assembleFinalPrompt(originalPrompt, selectedOptions);
      done({ finalPrompt, selectedOptions, decisions: decisionRecord(state.decisions) });
    };

    const component: Component = {
      render(width: number): string[] {
        clampCursor();
        const height = Math.max(10, tui.terminal.rows - 2);
        const contentWidth = frameContentWidth(width);
        const bodyRows = Math.max(1, height - frameChromeHeight(true));
        const body = renderBranchChecklistBody(theme, contentWidth, bodyRows, groups, state, session);
        return renderFrame({ width, height, theme, title: "prompt build branch choices", body, footer: undefined });
      },
      invalidate(): void {},
      handleInput(data: string): void {
        if (matchesKey(data, "escape")) return done(null);
        if (groups.length === 0) return done(null);

        if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) return finish();
        if (matchesKey(data, "up")) state.optionCursor = Math.max(0, state.optionCursor - 1);
        else if (matchesKey(data, "down")) state.optionCursor = Math.min((currentGroup()?.options.length ?? 0), state.optionCursor + 1);
        else if (matchesKey(data, "left")) moveBranch(-1);
        else if (matchesKey(data, "right")) moveBranch(1);
        else if (data === " " || matchesKey(data, "enter") || matchesKey(data, "return")) toggleCurrentRow();

        clampCursor();
        notifyStateChanged();
        tui.requestRender();
      },
    };

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

export function buildBranchGroups(branches: PromptBranchResult[], options: ParsedPromptOption[]): BranchOptionGroup[] {
  return branches
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((branch) => ({
      branchIndex: branch.index,
      title: branch.title,
      options: options.filter((option) => option.branchIndex === branch.index),
      error: branch.error ?? (branch.exitCode !== 0 ? `branch exited with code ${branch.exitCode}` : undefined),
    }));
}

export function renderBranchChecklistBody(
  theme: Theme,
  width: number,
  maxRows: number,
  groups: BranchOptionGroup[],
  state: PromptBuildReviewState,
  session: PromptBuildSessionFiles,
): string[] {
  const body: string[] = [];
  const group = groups[state.branchCursor];

  if (!group) {
    body.push(theme.fg("warning", "No prompt branches were generated."));
    body.push(theme.fg("dim", "Esc pauses; rerun prompt-build after fixing branch generation."));
    return padRows(body, maxRows);
  }

  body.push(theme.fg("accent", `${groups.length} Branches prompt - ${state.branchCursor + 1} of ${groups.length}`));
  body.push(theme.fg("warning", group.title));
  body.push(theme.fg("dim", `session ${shortenPath(session.dir)} · ↑↓ move · space check · ←/→ branch · ctrl+enter rebuild /prompt screen · esc pause`));
  body.push("");

  if (group.options.length === 0) {
    body.push(theme.fg("error", branchFailureMessage(group)));
    body.push(theme.fg("dim", "No fallback prompt option was created. Choose do not apply to ignore this failed branch."));
    body.push("");
  }

  const rows = [...group.options, null] as Array<ParsedPromptOption | null>;
  for (let i = 0; i < rows.length && body.length < Math.max(1, maxRows - 6); i += 1) {
    const option = rows[i];
    const selected = option ? decisionFor(state, option) === "selected" : branchIgnored(state, group);
    const cursor = i === state.optionCursor ? theme.fg("warning", "› ") : "  ";
    const checkbox = selected ? "[x]" : "[ ]";
    const text = option ? promptOptionChecklistText(option) : group.options.length === 0 ? "do not apply (ignore failed branch)" : "do not apply (ignore)";
    body.push(truncateToWidth(`${cursor}${theme.fg("accent", checkbox)} ${text}`, width, "…", false));
  }

  const current = group.options[state.optionCursor];
  if (current) {
    body.push("");
    body.push(theme.fg("accent", "exactText:"));
    for (const line of wrapPlainText(current.exactText, width - 2).slice(0, Math.max(1, maxRows - body.length - 3))) {
      body.push(`  ${line}`);
    }
    body.push(theme.fg("dim", truncateToWidth(`Reason: ${current.rationale}`, width, "…", false)));
  }

  body.push("");
  body.push(theme.fg("dim", renderBranchProgress(groups, state)));
  return padRows(body, maxRows);
}

export function promptOptionChecklistText(option: ParsedPromptOption): string {
  return option.exactText.trim();
}

function renderBranchProgress(groups: BranchOptionGroup[], state: PromptBuildReviewState): string {
  return groups.map((group, index) => {
    const selected = group.options.filter((option) => decisionFor(state, option) === "selected").length;
    const ignored = branchIgnored(state, group);
    const marker = index === state.branchCursor ? "▶" : " ";
    const status = ignored ? "ignored" : selected > 0 ? `${selected} selected` : group.options.length === 0 ? "failed" : "open";
    return `${marker}${index + 1}:${status}`;
  }).join("  ");
}

function branchIgnored(state: PromptBuildReviewState, group: BranchOptionGroup): boolean {
  if (group.options.length === 0) return state.ignoredBranches.has(group.branchIndex);
  return group.options.every((option) => decisionFor(state, option) === "ignored");
}

function branchFailureMessage(group: BranchOptionGroup): string {
  return group.error
    ? `Branch failed: ${group.error}`
    : "Branch failed: no structured JSON exactText candidates were returned.";
}

function decisionFor(state: PromptBuildReviewState, option: ParsedPromptOption): PromptOptionDecision {
  return state.decisions.get(option.id) ?? "undecided";
}

function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(8, width);
  const normalized = text.replace(/\t/g, "  ").split("\n");
  const lines: string[] = [];

  for (const rawLine of normalized) {
    const words = rawLine.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (visibleWidth(next) <= safeWidth) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = word;
    }
    if (line) lines.push(line);
  }

  return lines.length > 0 ? lines : [""];
}

function padRows(lines: string[], maxRows: number): string[] {
  while (lines.length < maxRows) lines.push("");
  return lines.slice(0, maxRows);
}

function shortenPath(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
