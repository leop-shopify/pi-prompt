---
description: "Loop Harness Verification Loop"
category: "Engineering"
author: "Istasha"
library_number: "020"
published: "2026-06-18"
modified: "2026-06-19"
---

# Loop Harness Verification Loop

## Prompt
Use Loop Harness for scheduled repository work such as CI triage, issue grooming, dependency updates, or docs sync. Set {{retry limit}}, then start an isolated git worktree. Let one Claude session stage a patch or outbox message and a second Claude session verify it against explicit criteria. Ship only after a pass; otherwise preserve the findings and retry only within the limit. Finish with the source revision, staged output, verifier result, delivery status, and next run.

## When to use
Use this when a recurring repository task should run unattended but one agent must not be allowed to generate and approve the same output.

## Success criteria
- Only independently verified output ships.
- A second-agent pass releases the configured output; a failed verification preserves evidence and produces no external change.

## Steps
1. Set the retry limit, wake the due Loop Harness task, and create an isolated worktree from the approved source revision.
2. Have the primary Claude session stage one bounded result without publishing it.
3. Have a second Claude session inspect the staged work against explicit acceptance criteria.
4. Ship on a pass; otherwise preserve the findings, publish nothing, and retry only until the preset limit.

## Rationale
Workspace isolation limits interference, and the second-agent gate separates generation from approval. The result can run repeatedly without relying on one session's confidence.

## Implementation notes
The source implementation uses Loop Harness, git worktrees, and separate model sessions. Start with read-only tasks, test one run first, cap runtime and retries, and grant only the tools each agent needs.
