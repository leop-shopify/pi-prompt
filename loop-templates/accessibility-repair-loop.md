---
description: "Accessibility Repair Loop"
category: "Design"
author: "Eric Lott"
library_number: "040"
published: "2026-06-20"
modified: "2026-06-20"
---

# Accessibility Repair Loop

## Prompt
Check {{scope}} against {{accessibility standard, such as WCAG 2.2 AA}} with automated scans and available keyboard, screen-reader, and other manual tests. Confirm each issue, rank it by harm, and fix the highest-impact blocker. Rerun the same checks, affected task, and regression tests. Keep only verified fixes. Stop when no blocker remains, progress stalls, verification is unavailable, or approval is required. Never silence a check or weaken the target. Return issues, fixes, evidence, exceptions, and untested needs.

## When to use
Use this when a website or app has a defined accessibility target and you can repeatedly test the relevant pages, components, or tasks for people using keyboards, screen readers, zoom, or other access methods.

## Success criteria
- No confirmed accessibility barrier remains in the agreed pages, components, or user tasks.
- The same automated scans, available manual checks, affected user task, and regression tests pass after each retained fix without lowering the chosen accessibility standard.

## Steps
1. Choose the pages, components, and user tasks to test; name the accessibility standard, such as WCAG 2.2 AA; and list the automated scans and manual checks that are actually available.
2. Run the baseline, reproduce each finding instead of trusting a tool warning by itself, and rank confirmed barriers by the number of people affected and how severely they are blocked.
3. Fix the most harmful barrier with the smallest underlying change, then repeat the same scan, manual check, user task, and relevant regression tests.
4. Keep only verified fixes and repeat until no confirmed barrier remains or progress stalls, evidence cannot be collected, work is blocked, or approval is required.

## Rationale
A fixed scope and repeated checks keep accessibility work tied to real people and reproducible evidence instead of an endless score chase. Fixing the most harmful confirmed barrier first directs effort to the users who are blocked most severely.

## Implementation notes
Automated tools can find likely problems but cannot prove a product is accessible. Manual keyboard use, screen-reader checks, zoom, contrast review, and real user testing may still be needed. Record anything the available test setup could not cover.
