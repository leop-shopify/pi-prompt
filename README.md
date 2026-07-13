# pi-prompt

`pi-prompt` is a better input interface for Pi. It provides a full-screen prompt editor with optional supersets for reusable prompts, durable planning, Grill critique, and browser-reviewed specifications.

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
- the **skills** field is optional: type a skill name and press Enter/comma to add it, Backspace removes chips, and `none` clears the selection. These are task-context skills; after the exact accepted Spec is sent, the receiving agent chooses execution leadership from the available leadership/orchestration skills.

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

Each session owns `~/.pi/agent/pi-prompt/plans/<session-id>/plan.md`, `annotations.json`, `clarifications.json`, and—after Grill—`grill.json`. The independent Spec sidecar lives under `<session-id>/spec/` with `spec.md`, `comments.json`, and, after acceptance, `final-spec.md`. `grill.json` contains generated critique metadata and the decision tree used as Spec input; the decision tree is not itself the Spec. Transient writer drafts such as `questions.json`, `grill-result.json`, and `spec-result.md` are not canonical artifacts.

The writer may inspect repository evidence only when the selected planning policy and request justify it. It uploads exact result bytes to a private authenticated loopback endpoint. Initial Plan, Grill, and Spec operations apply their operation-specific contracts. A Plan revision is deliberately simpler: matching active session/job/attempt IDs route the returned Markdown, which atomically replaces the authoritative `plan.md` without semantic re-grading or retained-element reconciliation. Spec generation separately enforces source freshness.

## Current-agent bridge

The durable `PlanController` owns the job, session directory, document revision, and state transitions. The bridge owns ephemeral correlation and canonicalizes only the first planner spawn. It never blocks the main agent's tools; the user can inspect files, check agent state, or perform unrelated work while planning runs.

The already-running review host creates the private writer endpoint before planning dispatch. Each attempt receives only that loopback submission URL and a rotating writer bearer, separate from the browser capability. After writing the operation-specific Plan, clarification, Grill, or Spec result, the writer uploads it with `curl --data-binary`; accepted HTTP bytes are persisted and published immediately without waiting for a report or another main-agent turn. Writer reports are cleanup-only and never carry the result or credentials. Initial Plan and Grill validation may use one correction attempt; Plan revisions instead accept the correlated replacement Markdown directly. Old attempts and late duplicates cannot settle an active job.

The generic `pi_prompt_submit_plan` tool is legacy compatibility only and cannot submit results. Teams-unavailable fallback uses the same authenticated HTTP handoff and fails safely if the review host has not configured it.

When Pi is idle, extension markers are sent with no delivery options. When Pi is busy, they are queued with `deliverAs: "followUp"`. `/prompt` returns after durable start, browser open, and dispatch; it does not wait for planning to finish.

## Browser review

The loopback review page starts immediately after the durable job transition. Its focused single-column view shows:

- the full original prompt;
- elapsed time and advisory budget in the page header;
- only the latest safe `report_progress` thinking summary in the activity card;
- the saved `plan.md` content directly below the run information.

The dark review page follows three explicit stages:

1. **Plan** is the durable, revisioned source artifact. Selecting Plan text creates light-yellow user comments with a compact bullet after the tagged text. **Revise Plan from comments** sends selected feedback to the planner; a successful replacement atomically updates `plan.md`, clears the consumed Plan comments and prior Grill artifact, and leaves semantic interpretation to the receiving agent. A short clarification batch may appear before the initial Plan, during which the Plan remains read-only. While a revision runs, the current Plan stays visible beneath **Rebuilding plan...**.
2. **Grill** displays that same Plan revision rather than rewriting it. Generated critique annotations appear in very light red and are body-immutable, while user comments remain editable in light yellow. Grill also persists a decision tree in `grill.json` for the next stage.
3. **To Spec** generates an independent, versioned Markdown specification from the exact Plan, annotations, and Grill decision tree. The Spec has its own selected-text comments and comment-driven revisions. If its Plan or Grill source changes, the browser requires a current Grill, then exposes **Generate fresh Spec**. That durable rebase preserves historical Spec states while binding the new generation to the current source.

Color is not the only provenance signal: comment controls and previews identify **Your comment** or **Grill critique**. **Accept & send Spec** atomically stores the exact accepted revision in `final-spec.md`, then dispatches an explicit implement-now instruction to the current Pi agent. Plan and Grill source references precede the exact accepted Spec Markdown, which remains unchanged as the trailing payload.

The server binds only to `127.0.0.1` on an operating-system port. A 256-bit fragment capability is copied into that tab's per-origin `sessionStorage` and removed from browser history. Because the port is part of the origin, separate review servers remain isolated and refresh works in the original tab. Browser API requests require the browser bearer and exact origin headers; the separate writer POST accepts only the current writer bearer, exact Host, supported result/content-type headers, and a bounded body. Snapshots are explicit allowlists: selected skill bodies, paths, cwd, nonces, controller/agent/team identity, tool arguments/results, report content, provenance metadata, and injected instructions are not exposed.

The browser loads exact committed Plan and Spec Markdown through authenticated endpoints. Plan/Grill Unicode-range comments are projected to `annotations.json`; Spec Unicode-range comments are projected to `spec/comments.json`. A Plan replacement clears its consumed comments and Grill output. Spec revisions safely re-anchor surviving Spec comments. The browser also keeps separate optimistic Plan and Spec ETags, replay-safe mutations, bounded authenticated long polling, and pause/cancel/reopen flows. Pi's terminal shows only one compact generation status beside the normal footer telemetry.

## Execution kind

Normal, Goal, and Loop control direct/no-plan sends:

- **Normal** sends the prompt without an execution prefix;
- **Goal** stages exactly one `/goal ` prefix;
- **Loop** stages exactly one `/loop ` prefix.

Typed leading `/goal` or `/loop` input is normalized into the same exclusive field. These direct-send choices do not alter accepted Spec dispatch. **Accept & send Spec** instructs the current agent to implement the authoritative Spec now in the current repository and continue through verification—not merely acknowledge it, report readiness, or rewrite it into another plan. The wrapper preserves normal current permissions and instructions: acceptance does not create `/create-goal` or issue-tracker items, nor does it silently commit, push, deploy, install dependencies, or start services.

## Verification

Use the pinned cached commands:

```sh
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 test
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 typecheck
COREPACK_ENABLE_STRICT=0 mise exec node@22 -- corepack pnpm@10.28.0 pack --dry-run
```
