# pi-prompt

A fullscreen, markdown-aware prompt editor for [Pi](https://github.com/earendil-works/pi). Open a big editing surface with live markdown coloring, char-precise selection, drafts, and file preloading, then send the whole thing as one message.

## Install

```bash
pi install https://github.com/leop-shopify/pi-prompt
```

Local development install:

```bash
pi install /path/to/pi-prompt
```

After installing, run `/reload` in any open Pi session, then use `/prompt`.

## Usage

- `/prompt` — open the fullscreen editor empty.
- `/prompt <path>` — open the editor preloaded with a file's contents (editable).
- `/prompt drafts` — pick a saved draft to reopen.

### Keys

| Key | Action |
| --- | --- |
| `ctrl+enter` | Send the prompt as a message |
| `enter` | Insert a newline |
| `esc` | Leave (if there is text, choose keep-draft or discard) |
| `shift+arrows` | Extend a character-precise selection |
| `ctrl+c` | Copy selection (or leave when nothing is selected) |
| `ctrl+x` | Cut selection |
| `ctrl+z` | Undo |
| `ctrl+a` / `ctrl+e` / `home` / `end` | Line start / end |
| `alt`/`option` + arrows, `ctrl` + arrows | Word movement (add `shift` to extend selection) |
| `ctrl+w` / `alt+backspace` | Delete word backward |
| `alt+d` / `alt+delete` | Delete word forward |
| `ctrl+u` / `ctrl+k` | Delete to line start / end |

Movement, word navigation, and deletion are routed through Pi's own keybinding registry, so they match the native input box exactly (including any keybinding customizations you have configured). When the agent is mid-turn, sending queues the prompt as a follow-up instead of interrupting the running turn.

## Notes

- The editor colorizes markdown source inline (headings, bold, italic, inline code, fenced code, lists, quotes, links, rules). Syntax markers stay visible and editable; only styling is added, so the cursor and selection map 1:1 onto the raw text.
- `ctrl+enter` requires a terminal that supports the Kitty keyboard protocol (most modern terminals; passes through tmux when the outer terminal supports it). In a terminal without it, `ctrl+enter` is indistinguishable from `enter`.
- Drafts are stored at `~/.pi/agent/extensions/pi-prompt-drafts.json`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Try it without installing:

```bash
pi -e ./src/index.ts
```
