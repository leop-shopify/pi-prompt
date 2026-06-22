---
description: "Architecture Satisfaction Loop"
category: "Engineering"
author: "Peter Steinberger"
library_number: "002"
published: "2026-06-12"
modified: "2026-06-17"
---

# Architecture Satisfaction Loop

## Prompt
Refactor until you are happy with the architecture. After each significant step, live-test the system, run autoreview, and commit. Track progress in /tmp/refactor-{projectname}.md.

## When to use
Use this for a deliberate architectural refactor where the destination can be stated in concrete terms and the current system can be tested after each meaningful change.

## Success criteria
- The architecture is satisfactory and checks pass.
- Live-test, autoreview, and commit each significant step.

## Steps
1. Write down the architectural target, constraints, and current risks before editing code.
2. Make one significant, reviewable change at a time.
3. Live-test the affected behavior and run an independent review after each significant step.
4. Commit each verified checkpoint and update the temporary progress file with decisions, blockers, and the next action.

## Rationale
Small verified checkpoints reduce refactor risk and preserve rollback points. The progress file keeps the goal and decisions available across long sessions or handoffs.

## Implementation notes
Define what satisfactory means before starting, such as module boundaries, dependency direction, passing tests, and acceptable performance. A subjective stop condition can otherwise run indefinitely.
