import { visibleWidth } from "@earendil-works/pi-tui";

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
const ANSI_GLOBAL = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Zero-width APC marker the TUI emits for hardware cursor positioning.
const APC_MARKER_GLOBAL = /\x1b_[^\x07\x1b]*\x07/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_GLOBAL, "").replace(APC_MARKER_GLOBAL, "");
}

/**
 * Extract a column range from a styled line, preserving any ANSI sequences that
 * were active before the range starts so the slice keeps its color. Column math
 * is grapheme-width aware (wide chars count as 2).
 */
export function sliceByColumn(line: string, startCol: number, length: number): string {
  if (length <= 0) return "";

  let column = 0;
  let index = 0;
  let result = "";
  let activeSequences = "";
  let started = false;

  while (index < line.length) {
    ANSI_PATTERN.lastIndex = index;
    const ansiMatch = ANSI_PATTERN.exec(line);
    if (ansiMatch != null) {
      const sequence = ansiMatch[0]!;
      index += sequence.length;
      if (!started && column < startCol) {
        activeSequences += sequence;
      } else {
        result += sequence;
      }
      continue;
    }

    const char = line[index]!;
    const charWidth = visibleWidth(char);
    const charStart = column;
    const charEnd = column + charWidth;

    if (charEnd > startCol && charStart < startCol + length) {
      if (!started) {
        result = activeSequences + result;
        started = true;
      }
      result += char;
    }

    column = charEnd;
    index += char.length;
    if (column >= startCol + length) break;
  }

  return result;
}

/** Pad a styled line with trailing spaces to reach the target visible width. */
export function padTo(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return text;
  return text + " ".repeat(width - current);
}

/**
 * Composite an overlay string onto a base line at a visible column offset,
 * keeping the base line's styling outside the overlay span. Returns a line
 * padded to totalWidth.
 */
export function compositeAt(baseLine: string, overlay: string, left: number, totalWidth: number): string {
  const prefix = sliceByColumn(baseLine, 0, left);
  const overlayWidth = visibleWidth(overlay);
  const suffixStart = left + overlayWidth;
  const suffix = sliceByColumn(baseLine, suffixStart, Math.max(0, totalWidth - suffixStart));
  const composed = `${prefix}${overlay}${suffix}`;
  return padTo(composed, totalWidth);
}

/**
 * Apply a wrapper (e.g. a theme background) over a visible column range of an
 * already-styled line. The characters inside the range are extracted with their
 * existing styling, wrapped, and composited back over the base line.
 */
export function highlightRange(
  baseLine: string,
  startCol: number,
  length: number,
  wrap: (segment: string) => string,
  totalWidth: number,
): string {
  if (length <= 0) return padTo(baseLine, totalWidth);
  const segment = sliceByColumn(baseLine, startCol, length);
  return compositeAt(baseLine, wrap(segment), startCol, totalWidth);
}
