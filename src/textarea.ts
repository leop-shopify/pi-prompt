import type { Theme } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  getKeybindings,
  type KeyId,
  matchesKey,
  decodeKittyPrintable,
  visibleWidth,
} from "@earendil-works/pi-tui";

type Keybindings = ReturnType<typeof getKeybindings>;
import { compositeAt, highlightRange, padTo, sliceByColumn } from "./ansi.js";
import { styleLines } from "./markdown-highlight.js";

interface Cursor {
  line: number;
  col: number;
}

interface VisualRow {
  line: number;
  gStart: number;
  gEnd: number;
}

interface LineLayout {
  graphemes: string[];
  /** Visible-width prefix sums. vis[i] = visible width of graphemes[0..i). */
  vis: number[];
  styled: string;
}

interface UndoSnapshot {
  lines: string[];
  cursor: Cursor;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function toGraphemes(line: string): string[] {
  if (line.length === 0) return [];
  const out: string[] = [];
  for (const part of segmenter.segment(line)) out.push(part.segment);
  return out;
}

function isInsertableText(data: string): boolean {
  if (data.length === 0) return false;
  for (const ch of data) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32 || cp === 127) return false;
  }
  return true;
}

export interface TextAreaCallbacks {
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
  onEscape?: (hasText: boolean) => void;
  onCopy?: (chars: number) => void;
  onToggle?: (text: string) => void;
}

/**
 * Fullscreen multi-line text editor with grapheme-aware word wrap, char-precise
 * shift-arrow selection, and live markdown coloring. The host owns the frame and
 * sets viewportHeight before each render; render() returns exactly that many
 * content rows. Cursor and selection columns are grapheme indices into the raw
 * logical line, kept 1:1 with the text regardless of styling.
 */
export class TextArea implements Component, Focusable {
  focused = true;
  viewportHeight = 10;

  private theme: Theme;
  private lines: string[] = [""];
  private cursor: Cursor = { line: 0, col: 0 };
  private selectionAnchor: Cursor | null = null;
  private scrollOffset = 0;
  private layouts: LineLayout[] = [];
  private undoStack: UndoSnapshot[] = [];
  private inPaste = false;
  private pasteBuffer = "";
  private callbacks: TextAreaCallbacks;

  constructor(theme: Theme, callbacks: TextAreaCallbacks = {}) {
    this.theme = theme;
    this.callbacks = callbacks;
    this.relayout();
  }

  setText(text: string): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");
    this.lines = normalized.length === 0 ? [""] : normalized.split("\n");
    this.cursor = { line: this.lines.length - 1, col: toGraphemes(this.lines[this.lines.length - 1]!).length };
    this.selectionAnchor = null;
    this.scrollOffset = 0;
    this.undoStack = [];
    this.relayout();
    this.emitChange();
  }

  getText(): string {
    return this.lines.join("\n");
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.relayout();
  }

  invalidate(): void {
    this.relayout();
  }

  private relayout(): void {
    const styled = styleLines(this.lines, this.theme);
    this.layouts = this.lines.map((line, i) => {
      const graphemes = toGraphemes(line);
      const vis: number[] = new Array(graphemes.length + 1);
      vis[0] = 0;
      for (let g = 0; g < graphemes.length; g += 1) {
        vis[g + 1] = vis[g]! + visibleWidth(graphemes[g]!);
      }
      return { graphemes, vis, styled: styled[i]! };
    });
  }

  private emitChange(): void {
    this.callbacks.onChange?.(this.getText());
  }

  private pushUndo(): void {
    this.undoStack.push({
      lines: [...this.lines],
      cursor: { ...this.cursor },
    });
    if (this.undoStack.length > 200) this.undoStack.shift();
  }

  private graphemesAt(line: number): string[] {
    return this.layouts[line]?.graphemes ?? [];
  }

  // --- Selection helpers -------------------------------------------------

  private hasSelection(): boolean {
    if (!this.selectionAnchor) return false;
    return this.selectionAnchor.line !== this.cursor.line || this.selectionAnchor.col !== this.cursor.col;
  }

  private orderedSelection(): { start: Cursor; end: Cursor } | null {
    if (!this.hasSelection() || !this.selectionAnchor) return null;
    const a = this.selectionAnchor;
    const b = this.cursor;
    const aBefore = a.line < b.line || (a.line === b.line && a.col <= b.col);
    return aBefore ? { start: { ...a }, end: { ...b } } : { start: { ...b }, end: { ...a } };
  }

  private getSelectedText(): string {
    const sel = this.orderedSelection();
    if (!sel) return "";
    const { start, end } = sel;
    if (start.line === end.line) {
      return this.graphemesAt(start.line).slice(start.col, end.col).join("");
    }
    const parts: string[] = [];
    parts.push(this.graphemesAt(start.line).slice(start.col).join(""));
    for (let l = start.line + 1; l < end.line; l += 1) {
      parts.push(this.graphemesAt(l).join(""));
    }
    parts.push(this.graphemesAt(end.line).slice(0, end.col).join(""));
    return parts.join("\n");
  }

  private deleteSelection(): void {
    const sel = this.orderedSelection();
    if (!sel) return;
    const { start, end } = sel;
    const startGraphemes = this.graphemesAt(start.line);
    const endGraphemes = this.graphemesAt(end.line);
    const merged = startGraphemes.slice(0, start.col).join("") + endGraphemes.slice(end.col).join("");
    this.lines.splice(start.line, end.line - start.line + 1, merged);
    this.cursor = { line: start.line, col: start.col };
    this.selectionAnchor = null;
    this.relayout();
  }

  private startOrUpdateSelection(extend: boolean): void {
    if (extend) {
      if (!this.selectionAnchor) this.selectionAnchor = { ...this.cursor };
    } else {
      this.selectionAnchor = null;
    }
  }

  // --- Editing -----------------------------------------------------------

  private insertText(text: string): void {
    this.pushUndo();
    if (this.hasSelection()) this.deleteSelection();
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "  ");
    const segments = normalized.split("\n");
    const graphemes = this.graphemesAt(this.cursor.line);
    const before = graphemes.slice(0, this.cursor.col).join("");
    const after = graphemes.slice(this.cursor.col).join("");

    if (segments.length === 1) {
      const inserted = segments[0]!;
      this.lines[this.cursor.line] = before + inserted + after;
      this.cursor.col += toGraphemes(inserted).length;
    } else {
      const newLines = [...segments];
      newLines[0] = before + newLines[0]!;
      const lastIdx = newLines.length - 1;
      const lastSeg = newLines[lastIdx]!;
      newLines[lastIdx] = lastSeg + after;
      this.lines.splice(this.cursor.line, 1, ...newLines);
      this.cursor.line += lastIdx;
      this.cursor.col = toGraphemes(lastSeg).length;
    }
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private insertNewline(): void {
    this.pushUndo();
    if (this.hasSelection()) this.deleteSelection();
    const graphemes = this.graphemesAt(this.cursor.line);
    const before = graphemes.slice(0, this.cursor.col).join("");
    const after = graphemes.slice(this.cursor.col).join("");
    this.lines.splice(this.cursor.line, 1, before, after);
    this.cursor.line += 1;
    this.cursor.col = 0;
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private backspace(): void {
    if (this.hasSelection()) {
      this.pushUndo();
      this.deleteSelection();
      this.emitChange();
      return;
    }
    if (this.cursor.col > 0) {
      this.pushUndo();
      const graphemes = this.graphemesAt(this.cursor.line);
      const next = graphemes.slice(0, this.cursor.col - 1).join("") + graphemes.slice(this.cursor.col).join("");
      this.lines[this.cursor.line] = next;
      this.cursor.col -= 1;
      this.relayout();
      this.emitChange();
    } else if (this.cursor.line > 0) {
      this.pushUndo();
      const prevGraphemes = this.graphemesAt(this.cursor.line - 1);
      const prevLen = prevGraphemes.length;
      const merged = prevGraphemes.join("") + this.lines[this.cursor.line]!;
      this.lines.splice(this.cursor.line - 1, 2, merged);
      this.cursor.line -= 1;
      this.cursor.col = prevLen;
      this.relayout();
      this.emitChange();
    }
  }

  private forwardDelete(): void {
    if (this.hasSelection()) {
      this.pushUndo();
      this.deleteSelection();
      this.emitChange();
      return;
    }
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col < graphemes.length) {
      this.pushUndo();
      const next = graphemes.slice(0, this.cursor.col).join("") + graphemes.slice(this.cursor.col + 1).join("");
      this.lines[this.cursor.line] = next;
      this.relayout();
      this.emitChange();
    } else if (this.cursor.line < this.lines.length - 1) {
      this.pushUndo();
      const merged = graphemes.join("") + this.lines[this.cursor.line + 1]!;
      this.lines.splice(this.cursor.line, 2, merged);
      this.relayout();
      this.emitChange();
    }
  }

  private deleteToLineStart(): void {
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col === 0) return;
    this.pushUndo();
    this.lines[this.cursor.line] = graphemes.slice(this.cursor.col).join("");
    this.cursor.col = 0;
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private wordLeftCol(): number {
    const graphemes = this.graphemesAt(this.cursor.line);
    let c = this.cursor.col;
    while (c > 0 && !this.isWordChar(graphemes[c - 1]!)) c -= 1;
    while (c > 0 && this.isWordChar(graphemes[c - 1]!)) c -= 1;
    return c;
  }

  private wordRightCol(): number {
    const graphemes = this.graphemesAt(this.cursor.line);
    let c = this.cursor.col;
    while (c < graphemes.length && !this.isWordChar(graphemes[c]!)) c += 1;
    while (c < graphemes.length && this.isWordChar(graphemes[c]!)) c += 1;
    return c;
  }

  private deleteWordBackward(): void {
    if (this.hasSelection()) {
      this.pushUndo();
      this.deleteSelection();
      this.emitChange();
      return;
    }
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col === 0) {
      this.backspace();
      return;
    }
    const target = this.wordLeftCol();
    if (target >= this.cursor.col) return;
    this.pushUndo();
    this.lines[this.cursor.line] =
      graphemes.slice(0, target).join("") + graphemes.slice(this.cursor.col).join("");
    this.cursor.col = target;
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private deleteWordForward(): void {
    if (this.hasSelection()) {
      this.pushUndo();
      this.deleteSelection();
      this.emitChange();
      return;
    }
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col >= graphemes.length) {
      this.forwardDelete();
      return;
    }
    const target = this.wordRightCol();
    if (target <= this.cursor.col) return;
    this.pushUndo();
    this.lines[this.cursor.line] =
      graphemes.slice(0, this.cursor.col).join("") + graphemes.slice(target).join("");
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private deleteToLineEnd(): void {
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col >= graphemes.length) return;
    this.pushUndo();
    this.lines[this.cursor.line] = graphemes.slice(0, this.cursor.col).join("");
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  private undo(): void {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.lines = [...snapshot.lines];
    this.cursor = { ...snapshot.cursor };
    this.selectionAnchor = null;
    this.relayout();
    this.emitChange();
  }

  // --- Cursor movement ---------------------------------------------------

  private clampCursor(): void {
    if (this.cursor.line < 0) this.cursor.line = 0;
    if (this.cursor.line > this.lines.length - 1) this.cursor.line = this.lines.length - 1;
    const len = this.graphemesAt(this.cursor.line).length;
    if (this.cursor.col < 0) this.cursor.col = 0;
    if (this.cursor.col > len) this.cursor.col = len;
  }

  private moveLeft(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    if (!extend && this.hasSelectionBeforeMove()) {
      const sel = this.orderedSelection();
      if (sel) {
        this.cursor = { ...sel.start };
        this.selectionAnchor = null;
        return;
      }
    }
    if (this.cursor.col > 0) {
      this.cursor.col -= 1;
    } else if (this.cursor.line > 0) {
      this.cursor.line -= 1;
      this.cursor.col = this.graphemesAt(this.cursor.line).length;
    }
  }

  private moveRight(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    if (!extend && this.hasSelectionBeforeMove()) {
      const sel = this.orderedSelection();
      if (sel) {
        this.cursor = { ...sel.end };
        this.selectionAnchor = null;
        return;
      }
    }
    const len = this.graphemesAt(this.cursor.line).length;
    if (this.cursor.col < len) {
      this.cursor.col += 1;
    } else if (this.cursor.line < this.lines.length - 1) {
      this.cursor.line += 1;
      this.cursor.col = 0;
    }
  }

  private selectionBeforeMove = false;
  private hasSelectionBeforeMove(): boolean {
    return this.selectionBeforeMove;
  }

  private moveVertical(delta: number, extend: boolean): void {
    this.startOrUpdateSelection(extend);
    const targetLine = this.cursor.line + delta;
    if (targetLine < 0 || targetLine > this.lines.length - 1) {
      // Move to start/end of current line at the document boundary.
      this.cursor.col = delta < 0 ? 0 : this.graphemesAt(this.cursor.line).length;
      if (!extend) this.selectionAnchor = null;
      return;
    }
    const currentVis = this.layouts[this.cursor.line]!.vis[this.cursor.col]!;
    const targetLayout = this.layouts[targetLine]!;
    let bestCol = 0;
    let bestDiff = Infinity;
    for (let g = 0; g <= targetLayout.graphemes.length; g += 1) {
      const diff = Math.abs(targetLayout.vis[g]! - currentVis);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestCol = g;
      }
    }
    this.cursor.line = targetLine;
    this.cursor.col = bestCol;
    if (!extend) this.selectionAnchor = null;
  }

  private moveLineStart(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    this.cursor.col = 0;
    if (!extend) this.selectionAnchor = null;
  }

  private moveLineEnd(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    this.cursor.col = this.graphemesAt(this.cursor.line).length;
    if (!extend) this.selectionAnchor = null;
  }

  private isWordChar(g: string): boolean {
    return /[\p{L}\p{N}_]/u.test(g);
  }

  private moveWordLeft(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    if (this.cursor.col === 0) {
      if (this.cursor.line > 0) {
        this.cursor.line -= 1;
        this.cursor.col = this.graphemesAt(this.cursor.line).length;
      }
    } else {
      this.cursor.col = this.wordLeftCol();
    }
    if (!extend) this.selectionAnchor = null;
  }

  private moveWordRight(extend: boolean): void {
    this.startOrUpdateSelection(extend);
    const graphemes = this.graphemesAt(this.cursor.line);
    if (this.cursor.col >= graphemes.length) {
      if (this.cursor.line < this.lines.length - 1) {
        this.cursor.line += 1;
        this.cursor.col = 0;
      }
    } else {
      this.cursor.col = this.wordRightCol();
    }
    if (!extend) this.selectionAnchor = null;
  }

  private async copySelection(): Promise<void> {
    const text = this.getSelectedText();
    if (text.length === 0) return;
    try {
      await copyToClipboard(text);
      this.callbacks.onCopy?.([...text].length);
    } catch {
      // Clipboard may be unavailable (no DISPLAY, headless); ignore silently.
    }
  }

  private cutSelection(): void {
    if (!this.hasSelection()) return;
    void this.copySelection();
    this.pushUndo();
    this.deleteSelection();
    this.emitChange();
  }

  // --- Layout / rendering ------------------------------------------------

  private buildVisualRows(wrapWidth: number): VisualRow[] {
    const rows: VisualRow[] = [];
    const width = Math.max(1, wrapWidth);
    for (let line = 0; line < this.lines.length; line += 1) {
      const layout = this.layouts[line]!;
      const n = layout.graphemes.length;
      if (n === 0) {
        rows.push({ line, gStart: 0, gEnd: 0 });
        continue;
      }
      let start = 0;
      while (start < n) {
        let col = 0;
        let j = start;
        let lastSpace = -1;
        while (j < n) {
          const w = layout.vis[j + 1]! - layout.vis[j]!;
          if (col + w > width && j > start) break;
          if (layout.graphemes[j] === " ") lastSpace = j;
          col += w;
          j += 1;
        }
        let end: number;
        if (j < n) {
          end = lastSpace >= start && lastSpace + 1 > start && lastSpace + 1 < j ? lastSpace + 1 : j;
        } else {
          end = n;
        }
        if (end <= start) end = start + 1;
        rows.push({ line, gStart: start, gEnd: end });
        start = end;
      }
    }
    return rows;
  }

  private findCursorRow(rows: VisualRow[]): number {
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]!;
      if (r.line !== this.cursor.line) continue;
      if (this.cursor.col >= r.gStart && this.cursor.col < r.gEnd) return i;
      // End of a logical line: cursor sits at gEnd of the last row for that line.
      if (this.cursor.col === r.gEnd) {
        const next = rows[i + 1];
        if (!next || next.line !== this.cursor.line) return i;
      }
    }
    return rows.length > 0 ? 0 : 0;
  }

  render(width: number): string[] {
    const wrapWidth = Math.max(1, width);
    const rows = this.buildVisualRows(wrapWidth);
    const cursorRow = this.findCursorRow(rows);

    if (cursorRow < this.scrollOffset) this.scrollOffset = cursorRow;
    else if (cursorRow >= this.scrollOffset + this.viewportHeight) {
      this.scrollOffset = cursorRow - this.viewportHeight + 1;
    }
    const maxScroll = Math.max(0, rows.length - this.viewportHeight);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;
    if (this.scrollOffset < 0) this.scrollOffset = 0;

    const sel = this.orderedSelection();
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + this.viewportHeight);
    const out: string[] = [];

    for (let i = 0; i < visible.length; i += 1) {
      const row = visible[i]!;
      const layout = this.layouts[row.line]!;
      const visStart = layout.vis[row.gStart]!;
      const visEnd = layout.vis[row.gEnd]!;
      const rowSlice = visStart === visEnd
        ? ""
        : sliceByColumn(layout.styled, visStart, visEnd - visStart);
      let lineText = padTo(rowSlice, wrapWidth);

      if (sel) {
        lineText = this.applySelectionToRow(lineText, row, layout, sel, wrapWidth);
      }

      const isCursorRow = this.scrollOffset + i === cursorRow && this.focused;
      if (isCursorRow) {
        lineText = this.applyCursorToRow(lineText, row, layout, wrapWidth);
      }

      out.push(lineText);
    }

    while (out.length < this.viewportHeight) out.push(" ".repeat(wrapWidth));
    return out;
  }

  private applySelectionToRow(
    lineText: string,
    row: VisualRow,
    layout: LineLayout,
    sel: { start: Cursor; end: Cursor },
    width: number,
  ): string {
    const { start, end } = sel;
    if (row.line < start.line || row.line > end.line) return lineText;

    let selStartCol = row.gStart;
    let selEndCol = row.gEnd;
    if (row.line === start.line) selStartCol = Math.max(selStartCol, start.col);
    if (row.line === end.line) selEndCol = Math.min(selEndCol, end.col);
    if (selEndCol <= selStartCol) {
      // Whole-line selection on an empty intermediate line: show a thin marker.
      if (row.line > start.line && row.line < end.line && layout.graphemes.length === 0) {
        return highlightRange(lineText, 0, 1, (s) => this.theme.bg("selectedBg", s), width);
      }
      return lineText;
    }
    const visStart = layout.vis[selStartCol]! - layout.vis[row.gStart]!;
    const visLen = layout.vis[selEndCol]! - layout.vis[selStartCol]!;
    return highlightRange(lineText, visStart, visLen, (s) => this.theme.bg("selectedBg", s), width);
  }

  private applyCursorToRow(lineText: string, row: VisualRow, layout: LineLayout, width: number): string {
    const cursorVis = layout.vis[this.cursor.col]! - layout.vis[row.gStart]!;
    const graphemeUnderCursor = layout.graphemes[this.cursor.col];
    const cell = graphemeUnderCursor && this.cursor.col < row.gEnd ? graphemeUnderCursor : " ";
    const styledCell = `${CURSOR_MARKER}\x1b[7m${cell}\x1b[27m`;
    return compositeAt(lineText, styledCell, cursorVis, width);
  }

  // --- Input -------------------------------------------------------------

  handleInput(data: string): void {
    if (this.inPaste || data.includes("\x1b[200~")) {
      this.handlePaste(data);
      return;
    }

    const kb = getKeybindings();
    this.selectionBeforeMove = this.hasSelection();

    // App-level actions that are not part of the native editor keymap.
    // ctrl+enter submits the whole prompt; plain enter inserts a newline.
    if (matchesKey(data, "ctrl+enter") || matchesKey(data, "ctrl+return")) {
      this.callbacks.onSubmit?.(this.getText());
      return;
    }
    // The same chord that opened the editor moves the text back to the main
    // input and closes, no draft prompt. Toggling an empty buffer just closes.
    if (matchesKey(data, "ctrl+alt+p")) {
      this.callbacks.onToggle?.(this.getText());
      return;
    }
    if (matchesKey(data, "escape")) {
      this.callbacks.onEscape?.(this.getText().trim().length > 0);
      return;
    }
    // ctrl+c (tui.input.copy): copy selection if any, otherwise treat as leave.
    if (kb.matches(data, "tui.input.copy")) {
      if (this.hasSelection()) void this.copySelection();
      else this.callbacks.onEscape?.(this.getText().trim().length > 0);
      return;
    }
    if (matchesKey(data, "ctrl+x")) {
      this.cutSelection();
      return;
    }
    if (kb.matches(data, "tui.editor.undo") || matchesKey(data, "ctrl+z")) {
      this.undo();
      return;
    }

    // Newline vs submit: the prompt uses enter for newline (ctrl+enter submits),
    // which is the inverse of the chat input. Honor the native newline binding
    // too so shift+enter also inserts a line break.
    if (kb.matches(data, "tui.input.newLine") || matchesKey(data, "enter") || matchesKey(data, "return")) {
      this.insertNewline();
      return;
    }

    // Selection-extending movement (shift+...). Not a native editor binding, so
    // matched explicitly. Word selection mirrors the native word-nav modifiers.
    if (matchesKey(data, "shift+left")) return this.afterMove(() => this.moveLeft(true));
    if (matchesKey(data, "shift+right")) return this.afterMove(() => this.moveRight(true));
    if (matchesKey(data, "shift+up")) return this.afterMove(() => this.moveVertical(-1, true));
    if (matchesKey(data, "shift+down")) return this.afterMove(() => this.moveVertical(1, true));
    if (matchesKey(data, "shift+home")) return this.afterMove(() => this.moveLineStart(true));
    if (matchesKey(data, "shift+end")) return this.afterMove(() => this.moveLineEnd(true));
    if (this.matchesShiftWord(data, kb, "left")) return this.afterMove(() => this.moveWordLeft(true));
    if (this.matchesShiftWord(data, kb, "right")) return this.afterMove(() => this.moveWordRight(true));

    // Cursor movement and editing: delegate to Pi's keybinding registry so the
    // behavior matches the native input exactly (including user customizations
    // and whatever escape sequences the terminal sends for alt/option/cmd).
    if (kb.matches(data, "tui.editor.cursorWordLeft")) return this.afterMove(() => this.moveWordLeft(false));
    if (kb.matches(data, "tui.editor.cursorWordRight")) return this.afterMove(() => this.moveWordRight(false));
    if (kb.matches(data, "tui.editor.cursorLineStart")) return this.afterMove(() => this.moveLineStart(false));
    if (kb.matches(data, "tui.editor.cursorLineEnd")) return this.afterMove(() => this.moveLineEnd(false));
    if (kb.matches(data, "tui.editor.cursorLeft")) return this.afterMove(() => this.moveLeft(false));
    if (kb.matches(data, "tui.editor.cursorRight")) return this.afterMove(() => this.moveRight(false));
    if (kb.matches(data, "tui.editor.cursorUp")) return this.afterMove(() => this.moveVertical(-1, false));
    if (kb.matches(data, "tui.editor.cursorDown")) return this.afterMove(() => this.moveVertical(1, false));

    // Deletion.
    if (kb.matches(data, "tui.editor.deleteWordBackward")) {
      this.deleteWordBackward();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteWordForward")) {
      this.deleteWordForward();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteToLineStart")) {
      this.deleteToLineStart();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
      this.deleteToLineEnd();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
      this.backspace();
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
      this.forwardDelete();
      return;
    }

    // Printable text (including kitty-encoded printables and multi-byte input).
    const kittyChar = decodeKittyPrintable(data);
    if (kittyChar) {
      this.insertText(kittyChar);
      return;
    }
    if (isInsertableText(data)) {
      this.insertText(data);
    }
  }

  /**
   * Match a shift+word-nav chord by deriving it from the native word-nav
   * binding: for each key bound to cursorWord{Left,Right}, also accept the same
   * chord with an added shift modifier (e.g. alt+left -> shift+alt+left).
   */
  private matchesShiftWord(data: string, kb: Keybindings, dir: "left" | "right"): boolean {
    const id = dir === "left" ? "tui.editor.cursorWordLeft" : "tui.editor.cursorWordRight";
    for (const key of kb.getKeys(id)) {
      if (key.includes("shift+")) continue;
      if (matchesKey(data, `shift+${key}` as KeyId)) return true;
    }
    return false;
  }

  private afterMove(move: () => void): void {
    move();
    this.clampCursor();
  }

  private handlePaste(data: string): void {
    let chunk = data;
    if (!this.inPaste) {
      const startIdx = chunk.indexOf("\x1b[200~");
      if (startIdx === -1) return;
      // Insert any text that preceded the paste marker as normal input.
      const before = chunk.slice(0, startIdx);
      if (isInsertableText(before)) this.insertText(before);
      this.inPaste = true;
      this.pasteBuffer = "";
      chunk = chunk.slice(startIdx + 6);
    }
    const endIdx = chunk.indexOf("\x1b[201~");
    if (endIdx === -1) {
      this.pasteBuffer += chunk;
      return;
    }
    this.pasteBuffer += chunk.slice(0, endIdx);
    const pasted = this.pasteBuffer;
    this.inPaste = false;
    this.pasteBuffer = "";
    if (pasted.length > 0) this.insertText(pasted);
    const remaining = chunk.slice(endIdx + 6);
    if (remaining.length > 0) this.handleInput(remaining);
  }
}
