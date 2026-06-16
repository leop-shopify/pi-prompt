import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Width-preserving markdown styling.
 *
 * This is NOT a markdown renderer. It keeps every raw character exactly where it
 * is (including syntax markers like #, *, `) and only wraps spans in zero-width
 * ANSI sequences. That invariant is load-bearing: the textarea maps cursor and
 * selection columns 1:1 onto the raw line, so any change to visible width or
 * character positions would desync the cursor.
 *
 * Styling is computed per logical line. Fenced code blocks span lines, so the
 * caller threads `inCodeFence` state through `styleLine`.
 */

export interface LineStyleResult {
  text: string;
  inCodeFence: boolean;
}

const FENCE_RE = /^(\s*)(```+|~~~+)(.*)$/;
const ATX_HEADING_RE = /^(\s{0,3})(#{1,6})(\s.*)?$/;
const BLOCKQUOTE_RE = /^(\s{0,3}>)(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;

/**
 * Style a single logical line, returning the styled text and the updated
 * code-fence state to pass into the next line.
 */
export function styleLine(line: string, theme: Theme, inCodeFence: boolean): LineStyleResult {
  const fenceMatch = FENCE_RE.exec(line);
  if (fenceMatch) {
    return { text: theme.fg("mdCodeBlockBorder", line), inCodeFence: !inCodeFence };
  }

  if (inCodeFence) {
    return { text: theme.fg("mdCodeBlock", line), inCodeFence };
  }

  if (line.trim().length === 0) {
    return { text: line, inCodeFence };
  }

  if (HR_RE.test(line)) {
    return { text: theme.fg("mdHr", line), inCodeFence };
  }

  const heading = ATX_HEADING_RE.exec(line);
  if (heading) {
    return { text: theme.fg("mdHeading", theme.bold(line)), inCodeFence };
  }

  const quote = BLOCKQUOTE_RE.exec(line);
  if (quote) {
    const marker = theme.fg("mdQuoteBorder", quote[1]!);
    const rest = quote[2] ? theme.fg("mdQuote", styleInline(quote[2], theme)) : "";
    return { text: marker + rest, inCodeFence };
  }

  const list = LIST_RE.exec(line);
  if (list) {
    const indent = list[1]!;
    const bullet = theme.fg("mdListBullet", list[2]!);
    const gap = list[3]!;
    const content = styleInline(list[4]!, theme);
    return { text: indent + bullet + gap + content, inCodeFence };
  }

  return { text: styleInline(line, theme), inCodeFence };
}

interface InlineRule {
  re: RegExp;
  style: (match: RegExpExecArray, theme: Theme) => string;
}

/**
 * Inline span rules. Each match keeps the original substring verbatim (markers
 * included) and only wraps it, so visible width is unchanged. Order matters:
 * code spans win first so markers inside them are not re-styled.
 */
const INLINE_RULES: InlineRule[] = [
  { re: /`[^`\n]+`/y, style: (m, t) => t.fg("mdCode", m[0]) },
  { re: /\*\*[^\s][^*\n]*?\*\*/y, style: (m, t) => t.bold(m[0]) },
  { re: /__[^\s][^_\n]*?__/y, style: (m, t) => t.bold(m[0]) },
  { re: /(?<!\*)\*[^\s*][^*\n]*?\*(?!\*)/y, style: (m, t) => t.italic(m[0]) },
  { re: /(?<!_)_[^\s_][^_\n]*?_(?!_)/y, style: (m, t) => t.italic(m[0]) },
  { re: /~~[^\s][^~\n]*?~~/y, style: (m, t) => t.strikethrough(m[0]) },
  { re: /\[[^\]\n]+\]\([^)\n]+\)/y, style: (m, t) => t.fg("mdLink", m[0]) },
  { re: /\bhttps?:\/\/[^\s)]+/y, style: (m, t) => t.fg("mdLinkUrl", m[0]) },
];

/**
 * Apply inline span styling across a string while preserving every character.
 * Walks left to right; at each index the first matching rule (anchored at that
 * index) wins, otherwise the single character is emitted unstyled.
 */
export function styleInline(text: string, theme: Theme): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    let matched = false;
    for (const rule of INLINE_RULES) {
      rule.re.lastIndex = index;
      const m = rule.re.exec(text);
      if (m && m.index === index) {
        result += rule.style(m, theme);
        index += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += text[index]!;
      index += 1;
    }
  }

  return result;
}

/**
 * Style a full array of logical lines, threading code-fence state. Returns one
 * styled string per input line, same length and order.
 */
export function styleLines(lines: string[], theme: Theme): string[] {
  const out: string[] = [];
  let inCodeFence = false;
  for (const line of lines) {
    const result = styleLine(line, theme, inCodeFence);
    out.push(result.text);
    inCodeFence = result.inCodeFence;
  }
  return out;
}
