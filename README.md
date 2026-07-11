# pi-prompt

`pi-prompt` is a Pi extension for writing prompts and, when requested, generating a durable structured implementation plan for secure browser review.

## Requirements

- Pi `0.78.1`
- Node.js 22
- pnpm `10.28.0`

## Prompt editor

Open `/prompt` (or `/pi-prompt`) for the fullscreen editor. `Ctrl+Alt+P` moves the current Pi input into it.

The editor starts in **No plan** with focus in the prompt:

- `Ctrl+Enter` is the primary action. In No plan it sends directly; with a planning level selected it starts plan generation.
- plain `Enter` inserts a newline;
- `Ctrl+Shift+Enter` explicitly sends without a plan from any selected level;
- `Ctrl+C` copies a selection and `Ctrl+X` cuts it;
- `Tab` and `Shift+Tab` move among controls;
- `Escape` opens the keep-draft/discard choice;
- `Ctrl+Alt+P` returns the text to Pi's main input.

There is no external-editor handoff.

Prompt sources remain available through `/prompt drafts`, `/prompt goal-templates`, `/prompt loop-templates`, `/prompt resume`, and `/prompt <file>`.

## Planning levels

Selecting a planning level starts a durable job and opens the private browser progress page before the planning request is dispatched.

| Level | Model slot | UI time budget | Intended use |
| --- | --- | ---: | --- |
| Quick win | `writing-basic` | 5 min | One bounded, low-risk change |
| Normal plan | `writing-basic` | 10 min | Ordinary features and fixes |
| Careful | `writing-basic` | 15 min | Risk, compatibility, persistence, security, or release-sensitive work |
| Hard thinker | `writing-hard` | 20 min | Architecture, boundaries, protocols, ownership, or migrations |
| Fully orchestrated | `writing-hard` | 30 min | Complex work spanning independent domains or repositories |

The displayed budgets are advisory: crossing one marks progress as over budget but never stops generation or a planner.

The packaged instructions live in `plans-mode/*.md` and remain the qualitative planning source of truth. Before each job starts, pi-prompt validates active `pi-extended-teams` capability through Pi's public tool catalog, parameter schema, and provenance metadata. When available, the adapter launches exactly one private write-capable planner using the selected level's semantic writer slot; no swarm or helper is allowed. If teams is unavailable before start, the current agent follows the same plan-file contract directly.

Each session owns `~/.pi/agent/pi-prompt/plans/<session-id>/plan.md` and `annotations.json`. The writer may inspect repository evidence but may modify only its assigned `plan.md`. TypeScript reads that file and enforces one title, one Execution section, actionable Implementation Tasks, limits, privacy screening, and stable revision reconciliation.

## Current-agent bridge

The durable `PlanController` owns the job, session directory, document revision, and state transitions. The bridge owns ephemeral correlation and canonicalizes only the first planner spawn. It never blocks the main agent's tools; the user can inspect files, check agent state, or perform unrelated work while planning runs.

The writer saves the complete Markdown plan to its exact session path. Pi-prompt watches that file and reads, validates, persists, and publishes it immediately; browser rendering does not wait for the writer's report or another main-agent turn. The writer still exits cleanly with `plan saved`, but that report is only a completion signal and never carries the plan or enters the lead conversation. One failed final validation may launch one correction writer; a second failure stops instead of looping.

The generic `pi_prompt_submit_plan` tool remains only for teams-unavailable fallback. The current agent writes the same `plan.md` file and submits the string `plan saved`; it does not send a structured plan through the tool.

When Pi is idle, extension markers are sent with no delivery options. When Pi is busy, they are queued with `deliverAs: "followUp"`. `/prompt` returns after durable start, browser open, and dispatch; it does not wait for planning to finish.

## Browser review

The loopback review page starts immediately after the durable job transition. Its focused single-column view shows:

- the full original prompt;
- elapsed time and advisory budget in the page header;
- only the latest safe `report_progress` thinking summary in the activity card;
- the saved `plan.md` content directly below the run information.

The dark review page presents the plan as one continuous text surface with no outline sidebar, per-section boxes, or Add note controls. Selecting plan text opens the contextual note composer. Saved notes live below the plan as disclosure cards whose expanded state survives refresh; **Send notes to agent** starts an in-place revision from `plan.md` plus `annotations.json`. Accept stages the exact accepted Markdown in Pi and never executes it automatically.

The server binds only to `127.0.0.1` on an operating-system port. A 256-bit fragment capability is copied into that tab's per-origin `sessionStorage` and removed from browser history. Because the port is part of the origin, separate review servers remain isolated and refresh works in the original tab. API requests require the bearer capability and exact origin headers. Snapshots are explicit allowlists: selected skill bodies, paths, cwd, nonces, controller/agent/team identity, tool arguments/results, report content, provenance metadata, and injected instructions are not exposed.

The browser loads `plan.md` through an authenticated endpoint even while controller materialization is still catching up. Element and Unicode text-range notes are projected separately to the session's `annotations.json`; revision jobs send that feedback to the writer, which rewrites `plan.md`. The browser also keeps optimistic state ETags, replay-safe mutations, bounded authenticated long polling, and pause/cancel/reopen flows. Pi's terminal shows only one compact planning status beside the normal footer telemetry.

## Execution kind

Planning depth is separate from accepted execution:

- **Normal** stages plain Markdown;
- **Goal** stages exactly one `/goal ` prefix;
- **Loop** stages exactly one `/loop ` prefix and reuses the existing pi-goal command.

Typed leading `/goal` or `/loop` input is normalized into the same exclusive field. Final acceptance always stages for human review and Enter.

## Verification

Use the pinned cached commands:

```sh
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 test
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 typecheck
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 pack --dry-run
```
