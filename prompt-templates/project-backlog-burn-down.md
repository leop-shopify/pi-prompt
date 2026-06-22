---
description: "Project backlog burn-down"
---
/goal triage and burn down a scoped project backlog by validating each item, completing authorized work, and leaving a transparent evidence-backed status board.

## Inputs
- Backlog source: <issues, TODOs, plan, spreadsheet, board, notes>
- Scope for this session: <items, labels, milestone, priority>
- Definition of done: <done criteria>
- Work limits and approval boundaries: <limits>

## Deliverables
- Normalized backlog table with item, priority, status, owner/area, evidence, and next action.
- Completed in-scope items with minimal changes when editing is authorized.
- Deferred/blocked list with reasons and recommended sequencing.
- Updated user-facing status summary.

## Verification surface
- Cite issue links, files, tests, commands, screenshots, logs, docs, or product checks used to validate each item.
- For completed items, show the done check and result.
- For rejected or duplicate items, cite the evidence used to close or merge them.

## Constraints
- Do not redefine priorities without evidence or user approval.
- Avoid large hidden scope expansion; split large items rather than pretending they are done.
- Do not commit, push, deploy, install packages, close external issues, or mutate production data unless explicitly requested.

## Iteration policy
- Triage first, pick the highest-priority feasible item, complete and verify it, update the board, then continue while scope remains clear.
- If an item reveals a larger product decision, mark it blocked and move to the next authorized item.

## Completion audit
Before declaring done, confirm:
- Every scoped backlog item has a status and evidence note.
- Completed items meet the stated definition of done.
- Blocked/deferred items include the smallest next decision or check needed.

## Blocked stop condition
Stop and ask for direction if priorities conflict, credentials are missing, external tracker mutation is required, or an item exceeds the authorized scope.

## Final artifact
Return a `Backlog Burn-Down Report` with: status board, completed items, verification evidence, blocked/deferred items, risks, and next recommended slice.
