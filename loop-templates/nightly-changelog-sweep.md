---
description: "Nightly Changelog Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "008"
published: "2026-06-16"
modified: "2026-06-17"
---

# Nightly Changelog Loop

## Prompt
Each night, review changes from the previous day and update the changelog with anything users should know.

## When to use
Use this when a project changes frequently enough that user-facing release notes can drift from merged pull requests, commits, deployments, and product changes.

## Success criteria
- Every user-relevant change from the previous day is accounted for.
- The changelog is updated and validated, or the no-change result is recorded.

## Steps
1. Collect the previous day's merged pull requests, commits, deployments, and other in-scope changes.
2. Identify which changes affect users and compare them with the current changelog.
3. Add concise dated entries with useful references while preserving existing content and avoiding duplicates.
4. Run the relevant checks and record either the validated update or the fact that no user-facing entry was needed.

## Rationale
A daily reconciliation makes omissions visible while the context is still fresh. Limiting entries to what users should know keeps the changelog useful instead of turning it into a raw commit feed.

## Implementation notes
Use the underlying change and product behavior as the source of truth. Commit titles alone can overstate, understate, or misclassify what users experienced.
