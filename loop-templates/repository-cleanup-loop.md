---
description: "Repository Cleanup Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "012"
published: "2026-06-16"
modified: "2026-06-17"
---

# Repository Cleanup Loop

## Prompt
Inspect local and remote branches, pull requests, commits, and worktrees. Recover valuable work and clean everything stale until the repository is current and organized.

## When to use
Use this when abandoned branches, old worktrees, unclear pull requests, or unmerged commits make it difficult to know which repository state still matters.

## Success criteria
- Valuable work is recovered and remaining repository state is intentional.
- Branches, pull requests, commits, and worktrees are current, owned, or safely removed with evidence.

## Steps
1. Inventory local and remote branches, open and recently closed pull requests, unmerged commits, and registered worktrees.
2. Classify each item as current, valuable but unfinished, superseded, merged, abandoned, or uncertain, recording evidence and ownership.
3. Recover valuable changes into an appropriate current branch before removing any stale reference.
4. Clean only proven stale state, fetch and prune safely, then rerun the inventory until every remaining item is intentional.

## Rationale
Inventory and classification separate recoverable work from clutter before cleanup begins. Repeating the inventory proves the repository is organized instead of merely smaller.

## Implementation notes
Do not delete uncertain work, discard uncommitted changes, or close someone else's pull request without confirmation. Preserve evidence for every destructive cleanup action.
