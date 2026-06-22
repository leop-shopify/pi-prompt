---
description: "Review user stories"
---
/goal create a canonical user-story coverage tracker for this product by inspecting the code, docs, and available tests, then verify the highest-risk stories against evidence surfaced in the conversation.

## Inputs
- Product area or repo scope: <scope>
- Known personas or customer segments: <personas>
- Source-of-truth docs, routes, specs, or tickets: <refs>
- Testing limits or environments available: <limits>

## Deliverables
- Feature inventory grouped by user journey or module.
- User stories in `As a / I want / so that` format with concrete acceptance criteria.
- Status for each story: implemented, partially implemented, unverified, broken, duplicate, or out of scope.
- Gap list separating code-observed behavior from inferred product expectations.

## Verification surface
- Cite exact files, routes, UI states, tests, commands, logs, screenshots, or docs used as evidence.
- For every broken or unverified story, state the check attempted and the observable result.
- Do not mark a story complete unless evidence is visible in the conversation.

## Constraints
- Do not invent requirements; label assumptions and ask when product intent is ambiguous.
- Preserve the existing product behavior while reviewing; do not fix code unless the user explicitly expands scope.
- Avoid broad cleanup, commits, pushes, deployments, installs, or service starts unless explicitly requested.

## Iteration policy
- Explore first, then draft the tracker, then verify high-risk stories, then update statuses.
- If editing is later authorized, fix one story at a time and rerun the relevant acceptance check before moving on.

## Completion audit
Before declaring done, confirm:
- Every discovered feature has at least one story or an explicit out-of-scope note.
- Every status has evidence or a stated reason it could not be verified.
- The highest-risk broken or unverified stories are called out at the top.

## Blocked stop condition
Stop and ask for direction if required credentials, environments, product decisions, destructive operations, or missing source material prevent reliable status assignment.

## Final artifact
Return a `User Story Coverage Report` with: summary, tracker table, evidence references, verified checks, gaps/risks, recommended next actions, and blocked items.
