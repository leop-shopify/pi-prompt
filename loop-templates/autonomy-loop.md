---
description: "Autonomy Loop: Builder and Reviewer"
category: "Engineering"
author: "@inferencegod"
library_number: "027"
published: "2026-06-19"
modified: "2026-06-19"
---

# Autonomy Loop: Builder and Reviewer

## Prompt
Use autonomy-loop for {{repository task}} after the test, build, and lint gates pass. Run /autonomy-loop:autonomy-init, then start builder and reviewer in separate worktrees. The builder reads LOOP-STATE.md, makes one bounded change, and adds a red-before, green-after test. The reviewer reruns the gates and proves the test by reverting or mutating the fix. Accept only on both passes; park protected or repeated-failure work for a human. Finish with the commit, gate evidence, test proof, trust tier, and risks.

## When to use
Use autonomy-loop when a repository has deterministic test, build, and lint gates plus a task suited to repeated builder-reviewer handoffs.

## Success criteria
- Every accepted wave passes autonomy-loop's proof-of-test gate.
- The new test fails without the change, passes with it, every configured gate passes, and protected production changes remain human-gated.

## Steps
1. Initialize autonomy-loop, configure deterministic gates and protected paths, and create separate builder and reviewer worktrees.
2. Have the builder read LOOP-STATE.md, implement one bounded change, add a red-before, green-after test, and hand off.
3. Have the reviewer rerun every gate and use revert-or-mutate proof to show the test catches the change.
4. Accept only on both passes; otherwise return findings or park the wave for a human when a circuit breaker fires.

## Rationale
Separate worktrees and a git-backed LOOP-STATE.md baton keep the roles independent and resumable. The revert-or-mutate check catches tests that execute code without proving the fix.

## Implementation notes
The source implementation uses autonomy-loop commands, separate worktrees, and a git-backed baton. Treat local hooks as tripwires, not a security boundary, and keep protected changes behind enforced approval.
