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
- `Ctrl+Alt+P` returns the text to Pi's main input;
- the **skills** field is optional: type a skill name and press Enter/comma to add it, Backspace removes chips, and `none` clears the selection. These are task-context skills; for an accepted plan or direct Create Goal request, the receiving agent chooses execution leadership from the available leadership/orchestration skills.

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

Each session owns `~/.pi/agent/pi-prompt/plans/<session-id>/plan.md`, `annotations.json`, and `clarifications.json`. The writer may inspect repository evidence only when the selected planning policy and request justify it. It writes a local `plan.md` (or bounded `questions.json`) for ergonomics, then uploads those exact bytes to a private authenticated loopback endpoint. The controller validates the correlated HTTP bytes—never mutable writer paths—as the sole completion authority and enforces the plan shape, limits, privacy screening, and stable revision reconciliation.

## Current-agent bridge

The durable `PlanController` owns the job, session directory, document revision, and state transitions. The bridge owns ephemeral correlation and canonicalizes only the first planner spawn. It never blocks the main agent's tools; the user can inspect files, check agent state, or perform unrelated work while planning runs.

The already-running review host creates the private writer endpoint before planning dispatch. Each attempt receives only that loopback submission URL and a rotating writer bearer, separate from the browser capability. After writing `plan.md` or `questions.json`, the writer uploads it with `curl --data-binary`; accepted HTTP bytes are validated, persisted, and published immediately without waiting for a report or another main-agent turn. Writer reports are cleanup-only and never carry the result or credentials. One failed validation rotates the bearer and may launch one correction writer; the old attempt, late duplicates, and a second failed correction cannot settle the job.

The generic `pi_prompt_submit_plan` tool is legacy compatibility only and cannot submit results. Teams-unavailable fallback uses the same authenticated HTTP handoff and fails safely if the review host has not configured it.

When Pi is idle, extension markers are sent with no delivery options. When Pi is busy, they are queued with `deliverAs: "followUp"`. `/prompt` returns after durable start, browser open, and dispatch; it does not wait for planning to finish.

## Browser review

The loopback review page starts immediately after the durable job transition. Its focused single-column view shows:

- the full original prompt;
- elapsed time and advisory budget in the page header;
- only the latest safe `report_progress` thinking summary in the activity card;
- the saved `plan.md` content directly below the run information.

The dark review page presents the plan as one continuous text surface with no outline sidebar or per-section boxes. Selecting plan text opens the contextual note composer. Comments appear as gold inline badges at the ends of their annotated text: hover or focus previews a comment, and click or keyboard activation opens editing. **Send notes to agent** starts an in-place revision from the committed plan plus `annotations.json`. A short batch of clarification questions can appear before an initial or revision plan; submitting every answer continues the same planning operation. While answers are pending, the visible plan and comments remain read-only. **Accept & send** commits the exact accepted Markdown, sends the selected Normal/Goal/Loop/Create Goal form to Pi as the next user message, and starts the receiving agent immediately.

The server binds only to `127.0.0.1` on an operating-system port. A 256-bit fragment capability is copied into that tab's per-origin `sessionStorage` and removed from browser history. Because the port is part of the origin, separate review servers remain isolated and refresh works in the original tab. Browser API requests require the browser bearer and exact origin headers; the separate writer POST accepts only the current writer bearer, exact Host, supported result/content-type headers, and a bounded body. Snapshots are explicit allowlists: selected skill bodies, paths, cwd, nonces, controller/agent/team identity, tool arguments/results, report content, provenance metadata, and injected instructions are not exposed.

The browser loads the exact committed Markdown through an authenticated endpoint. Element and Unicode text-range notes are projected separately to the session's `annotations.json`; revision jobs send selected feedback to the writer, which uploads a replacement plan for controller validation. The browser also keeps optimistic state ETags, replay-safe mutations, bounded authenticated long polling, and pause/cancel/reopen flows. Pi's terminal shows only one compact planning status beside the normal footer telemetry.

## Execution kind

Planning depth is separate from accepted execution:

- **Normal** sends plain Markdown;
- **Create Goal** sends exactly one `/create-goal ` prefix so the `pi-codex-goal` prompt template can create a tracked goal from the accepted reviewed plan;
- **Goal** sends exactly one `/goal ` prefix;
- **Loop** sends exactly one `/loop ` prefix and reuses the existing pi-goal command.

Typed leading `/goal`, `/loop`, or `/create-goal` input is normalized into the same exclusive field. Final acceptance sends the selected execution form immediately; it does not copy the plan into the editor. Accepted plans receive the execution-leadership bootstrap, and direct Create Goal staging receives the same bootstrap before selected skill blocks. The receiving lead must choose an available leadership/orchestration skill, build outcome-based tasks and dependencies before implementation, keep a sole execution lane with the lead, delegate only genuinely independent bounded lanes, and retain integration, cross-lane decisions, and final verification.

## Verification

Use the pinned cached commands:

```sh
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 test
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 typecheck
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 pack --dry-run
```
