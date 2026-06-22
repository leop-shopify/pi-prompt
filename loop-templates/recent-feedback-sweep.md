---
description: "Recent Feedback Sweep"
category: "Engineering"
author: "Matthew Berman"
library_number: "031"
published: "2026-06-19"
modified: "2026-06-19"
---

# Recent Feedback Sweep

## Prompt
Review all available threads from {{lookback window}} where I reported something wrong with {{project}} and asked for a fix. Build a deduplicated issue list, group it into failure patterns, and verify current state. Audit the complete project for every pattern, fix each confirmed instance, and add regression coverage where practical. Repeat the full audit until it finds no remaining instance or {{iteration budget}} ends. Stop on blocked or approval-gated work. Return the issues, fixes, evidence, and blockers.

## When to use
Use this after several days of project feedback when repeated mistakes may point to similar issues elsewhere and the agent can inspect both the conversation history and the complete current project.

## Success criteria
- The issue inventory is closed and a fresh pattern audit is clean.
- Every reported issue and newly found match has current proof of resolution; blocked, approval-gated, or budget-exhausted items remain explicitly open.

## Steps
1. Define the lookback window and complete project surface, then collect every accessible thread in which the user reported a problem and requested a fix.
2. Deduplicate the reported issues, verify their current status, and turn the concrete examples into explicit failure patterns and audit checks.
3. Audit every in-scope project surface for each pattern, fix one confirmed instance at a time, and add regression coverage where practical.
4. Run targeted checks after each fix, then rerun the complete pattern audit and relevant full checks before declaring the sweep clean.

## Rationale
Recent corrections are concrete examples of the quality bar the project missed. Grouping them into failure patterns turns one-off feedback into a reusable audit rubric, while a fresh full sweep catches sibling defects and verifies the current project rather than trusting old thread state.

## Implementation notes
Thread access and a complete surface inventory are prerequisites. Do not infer defects from neutral discussion, reopen resolved issues without checking current behavior, or claim success while an inaccessible, blocked, approval-gated, or budget-exhausted item remains. Get approval before destructive, production, or external actions.
