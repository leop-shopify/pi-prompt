---
description: "Stale-Safe Batch Release Loop"
category: "Operations"
author: "Matthew Berman"
library_number: "013"
published: "2026-06-16"
modified: "2026-06-17"
---

# Stale-Safe Batch Release Loop

## Prompt
Review pending changes and pull requests, exclude stale or unfinished work, combine the valid changes, and release them together.

## When to use
Use this when several branches or pull requests may be ready at once and the release must avoid stale worktrees, partial overlays, and incomplete changes.

## Success criteria
- Only current, complete changes ship in the combined release.
- The released revision is the latest integrated main that contains every selected change.

## Steps
1. Fetch current repository and pull-request state, then inspect every candidate change for freshness, completeness, ownership, checks, and dependencies.
2. Exclude stale, superseded, conflicting, or unfinished work and record why each candidate was omitted.
3. Integrate the valid changes, rerun the combined checks, and select the newest main revision that contains the full batch.
4. Release complete artifacts from a clean checkout, serialize the deployment, and verify production before closing the batch.

## Rationale
Evaluating all candidates before integration prevents stale code from entering a release through convenience or worktree confusion. Releasing from integrated main proves the deployed artifact matches the reviewed batch.

## Implementation notes
The candidate diff selects what belongs in the batch, but deployment must use complete artifacts from the latest integrated main. Never deploy from a task worktree or partial file overlay.
