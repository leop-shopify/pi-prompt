import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({ ...(await importOriginal<object>()), copyToClipboard: vi.fn(async () => undefined) }));
import { stripAnsi } from "../ansi.js";
import { TextArea } from "../textarea.js";
import { makeTestTheme } from "./helpers.js";

const theme = makeTestTheme();

const KEY = {
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
  shiftLeft: "\x1b[1;2D",
  shiftRight: "\x1b[1;2C",
  shiftDown: "\x1b[1;2B",
  shiftUp: "\x1b[1;2A",
  backspace: "\x7f",
  home: "\x1b[H",
  end: "\x1b[F",
};

function type(area: TextArea, text: string): void {
  for (const ch of text) area.handleInput(ch);
}

describe("TextArea editing", () => {
  it("types characters into the buffer", () => {
    const area = new TextArea(theme);
    type(area, "hello");
    expect(area.getText()).toBe("hello");
  });

  it("inserts a newline on enter", () => {
    const area = new TextArea(theme);
    type(area, "ab");
    area.handleInput("\r");
    type(area, "cd");
    expect(area.getText()).toBe("ab\ncd");
  });

  it("backspaces within and across lines", () => {
    const area = new TextArea(theme);
    type(area, "ab");
    area.handleInput("\r");
    type(area, "cd");
    area.handleInput(KEY.backspace); // remove d
    expect(area.getText()).toBe("ab\nc");
    area.handleInput(KEY.backspace); // remove c
    area.handleInput(KEY.backspace); // join lines
    expect(area.getText()).toBe("ab");
  });

  it("moves the cursor and inserts mid-line", () => {
    const area = new TextArea(theme);
    type(area, "ace");
    area.handleInput(KEY.left); // between c and e
    type(area, "d");
    expect(area.getText()).toBe("acde");
  });

  it("setText replaces content and normalizes CRLF and tabs", () => {
    const area = new TextArea(theme);
    area.setText("a\r\nb\tc");
    expect(area.getText()).toBe("a\nb  c");
  });

  it("reports first and last logical line cursor boundaries", () => {
    const area = new TextArea(theme);
    area.setText("one\ntwo\nthree");
    expect(area.isCursorOnFirstLogicalLine()).toBe(false);
    expect(area.isCursorOnLastLogicalLine()).toBe(true);
    area.handleInput(KEY.up);
    expect(area.isCursorOnFirstLogicalLine()).toBe(false);
    expect(area.isCursorOnLastLogicalLine()).toBe(false);
    area.handleInput(KEY.up);
    expect(area.isCursorOnFirstLogicalLine()).toBe(true);
    expect(area.isCursorOnLastLogicalLine()).toBe(false);
  });

  it("fires submit on ctrl+enter (kitty) with full text", () => {
    const onSubmit = vi.fn();
    const area = new TextArea(theme, { onSubmit });
    type(area, "send me");
    area.handleInput("\x1b[13;5u"); // kitty ctrl+enter
    expect(onSubmit).toHaveBeenCalledWith("send me");
  });


  it("fires escape with hasText flag", () => {
    const onEscape = vi.fn();
    const area = new TextArea(theme, { onEscape });
    area.handleInput("\x1b"); // escape, empty
    expect(onEscape).toHaveBeenLastCalledWith(false);
    type(area, "x");
    area.handleInput("\x1b");
    expect(onEscape).toHaveBeenLastCalledWith(true);
  });

  it("fires toggle on ctrl+alt+p with full text", () => {
    const onToggle = vi.fn();
    const area = new TextArea(theme, { onToggle });
    type(area, "half written");
    area.handleInput("\x1b[112;7u"); // kitty ctrl+alt+p
    expect(onToggle).toHaveBeenCalledWith("half written");
  });

  it("fires toggle with empty text when buffer is empty", () => {
    const onToggle = vi.fn();
    const area = new TextArea(theme, { onToggle });
    area.handleInput("\x1b[112;7u");
    expect(onToggle).toHaveBeenCalledWith("");
  });
});

describe("TextArea word movement", () => {
  const WORD = {
    altLeft: "\x1b[1;3D",
    altRight: "\x1b[1;3C",
    ctrlLeft: "\x1b[1;5D",
    ctrlRight: "\x1b[1;5C",
    optB: "\x1bb", // macOS Option+Left (readline-style)
    optF: "\x1bf", // macOS Option+Right
    // kitty "report event types" repeat variants (key held down)
    altLeftRepeat: "\x1b[1;3:2D",
    shiftAltLeft: "\x1b[1;4D",
  } as const;

  function col(area: TextArea): number {
    return (area as unknown as { cursor: { col: number } }).cursor.col;
  }

  it("option (alt) + left/right moves by word, both encodings", () => {
    const area = new TextArea(theme);
    area.setText("hello world foo");
    area.handleInput(WORD.altLeft); // end (15) -> start of 'foo' (12)
    expect(col(area)).toBe(12);
    area.handleInput(WORD.optB); // readline ESC b -> start of 'world' (6)
    expect(col(area)).toBe(6);
    area.handleInput(WORD.optF); // ESC f -> end of 'world' (11)
    expect(col(area)).toBe(11);
  });

  it("ctrl + arrows also move by word", () => {
    const area = new TextArea(theme);
    area.setText("hello world foo");
    area.handleInput(WORD.ctrlLeft);
    expect(col(area)).toBe(12);
    area.handleInput(WORD.ctrlRight);
    expect(col(area)).toBe(15);
  });

  it("kitty repeat events (held key) still move by word", () => {
    const area = new TextArea(theme);
    area.setText("hello world foo");
    area.handleInput(WORD.altLeftRepeat);
    expect(col(area)).toBe(12);
    area.handleInput(WORD.altLeftRepeat);
    expect(col(area)).toBe(6);
  });

  it("shift + alt + left extends a word selection", () => {
    const area = new TextArea(theme);
    area.setText("hello world foo");
    area.handleInput(WORD.shiftAltLeft); // select back over 'foo'
    type(area, "X");
    expect(area.getText()).toBe("hello world X");
  });

  it("delete word backward/forward via native bindings", () => {
    const area = new TextArea(theme);
    area.setText("hello world foo");
    area.handleInput("\x1b\x7f"); // alt+backspace -> delete 'foo'
    expect(area.getText()).toBe("hello world ");
    area.handleInput("\x17"); // ctrl+w -> delete 'world '
    expect(area.getText()).toBe("hello ");
  });
});

describe("TextArea selection", () => {
  it("shift+left selects and typing replaces the selection", () => {
    const area = new TextArea(theme);
    type(area, "abcd");
    area.handleInput(KEY.shiftLeft); // select "d"
    area.handleInput(KEY.shiftLeft); // select "cd"
    type(area, "X");
    expect(area.getText()).toBe("abX");
  });

  it("backspace deletes an active selection", () => {
    const area = new TextArea(theme);
    type(area, "hello");
    area.handleInput(KEY.shiftLeft);
    area.handleInput(KEY.shiftLeft);
    area.handleInput(KEY.backspace);
    expect(area.getText()).toBe("hel");
  });

  it("shift+down extends selection across lines and replaces", () => {
    const area = new TextArea(theme);
    area.setText("line1\nline2");
    area.handleInput(KEY.home); // start of line2
    area.handleInput(KEY.up); // start of line1 (col preserved at 0)
    area.handleInput(KEY.shiftDown); // select line1 + into line2 col0
    type(area, "X");
    expect(area.getText()).toBe("Xline2");
  });

  it("copies and cuts only the active selection", async () => {
    const onCopy = vi.fn(); const area = new TextArea(theme, { onCopy });
    area.setText("copy me"); area.handleInput(KEY.shiftLeft); area.handleInput(KEY.shiftLeft);
    area.handleInput("\x03"); await vi.waitFor(() => expect(copyToClipboard).toHaveBeenCalledWith("me"));
    expect(onCopy).toHaveBeenCalledWith(2); expect(area.getText()).toBe("copy me");
    area.handleInput("\x18"); expect(area.getText()).toBe("copy ");
  });
});

describe("TextArea rendering", () => {
  it("returns exactly viewportHeight rows", () => {
    const area = new TextArea(theme);
    area.viewportHeight = 6;
    area.setText("one\ntwo\nthree");
    const lines = area.render(40);
    expect(lines).toHaveLength(6);
  });

  it("word-wraps long logical lines across visual rows", () => {
    const area = new TextArea(theme);
    area.viewportHeight = 10;
    area.setText("aaaa bbbb cccc dddd");
    const lines = area.render(10).map(stripAnsi).map((l) => l.trimEnd());
    const nonEmpty = lines.filter((l) => l.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(1);
    expect(nonEmpty.every((l) => l.length <= 10)).toBe(true);
  });

  it("keeps rendered visible text equal to the source characters", () => {
    const area = new TextArea(theme);
    area.viewportHeight = 10;
    area.setText("# Title\n- item `code`");
    const rendered = area.render(40).map(stripAnsi).join("\n");
    expect(rendered).toContain("# Title");
    expect(rendered).toContain("- item `code`");
  });
});
