---
description: "Goal Forge Loop"
category: "Engineering"
author: "michael Guo (@michaelzsguo)"
library_number: "035"
published: "2026-06-20"
modified: "2026-06-20"
---

# Goal Forge Loop

## Prompt
Turn {{rough coding idea}} into two planning files before Codex starts /goal, its long-running task mode. Interview the user, then write SPEC.md: what to build, exclude, and consider, plus measurable done_when completion checks. Write GOAL.md: the work plan, progress scorecard, quick and final checks, memory files, evidence, and approval boundaries. If any key decision, permission, tool, environment requirement, or test is missing, stop as not ready. Do not start implementation without approval.

## When to use
Use this when a rough coding idea is too vague to hand to Codex for a long autonomous run and the user first needs to settle scope, completion checks, safety boundaries, and required tools.

## Success criteria
- The planning files say what to build, how to judge it, and when to stop.
- Every done_when completion check names observable evidence, the quick and final checks can actually run, the environment is ready, and unresolved decisions are clearly marked not ready.

## Steps
1. Ask the user what the finished feature should do, what is out of scope, which edge cases matter, what could go wrong, and what evidence would prove completion; write those decisions in SPEC.md.
2. Point out ambiguous requirements with concrete interpretations and have the user resolve product decisions instead of letting the coding agent silently choose.
3. Write GOAL.md with the ordered work, a progress scorecard, quick checks for each iteration, slower final checks, memory files for long runs, approval boundaries, and required evidence.
4. Confirm that the tools, permissions, environment, and tests exist; stop as not ready when anything essential is missing, and start the long-running task only after approval.

## Rationale
Goal Forge makes the user decide what success means before an agent spends hours coding. The two files give Codex a stable target, repeatable checks, memory across a long run, and an honest not-ready state when important information is missing.

## Implementation notes
In the source workflow, /goal is Codex's long-running task mode. SPEC.md describes the product decision; GOAL.md tells Codex how to execute and verify it; PLAN.md, ATTEMPTS.md, and NOTES.md preserve progress and learning across the run.
