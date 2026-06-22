---
description: "Codex Completion Contract Loop"
category: "Engineering"
author: "3goblack (@Dis_Trackted)"
library_number: "028"
published: "2026-06-19"
modified: "2026-06-19"
---

# Codex Completion Contract Loop

## Prompt
Run $goal-planner-codex {{task}} for long-running Codex work where partial work could be mistaken for done. Landing a PR and verifying production is one example. Before acting, define every required outcome and its evidence. After each bounded action, mark requirements proved, weak, missing, or contradicted. Complete the Goal only when all are proved; otherwise stop as blocked, stalled, or exhausted. Ask before creating Goal state. Finish with the requirement-to-evidence table, status, owner, and next action.

## When to use
Use this for long-running Codex work, pull requests, runtime checks, or user-visible artifacts where a plausible partial result could be mistaken for completion.

## Success criteria
- Every Codex Goal requirement has current, adequate proof.
- The final audit contains no weak, missing, or contradicted required item; otherwise the work remains open, blocked, or exhausted.

## Steps
1. Recover a measurable definition of done for every ambiguous requirement.
2. Record the requirements, scope, non-goals, evidence plan, and current status without expanding the requested work.
3. Execute one bounded action at a time and attach current evidence to each affected requirement.
4. Audit every requirement before closure and preserve honest blocked, exhausted, stalled, or contradicted states.

## Rationale
A durable completion contract keeps the definition of done visible across long sessions. Mapping every requirement to evidence makes false completion easy to detect.

## Implementation notes
Use $goal-planner-codex only when the user explicitly asks for a Codex Goal or completion audit. Create native Goal state only with approval; ordinary task planning does not need it, and budget exhaustion never counts as success.
