---
description: "Sub-50 ms Page-Load Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "003"
published: "2026-06-12"
modified: "2026-06-17"
---

# Sub-50 ms Page-Load Loop

## Prompt
Continue optimizing the code for speed. After each significant change, measure page-load performance across every page under the same repeatable test conditions. Continue until every page loads in under 50 ms.

## When to use
Use this when a product has a defined set of routes, a stable performance harness, and a 50 ms target that maps to a specific metric and environment.

## Success criteria
- Every page loads in under 50 ms.
- Use the same benchmark and confirm there are no regressions.

## Steps
1. Define the exact metric, routes, test environment, warm-up behavior, and number of benchmark runs.
2. Capture a baseline for every target page before making changes.
3. Make one significant optimization, rerun the same benchmark, and inspect regressions across all routes.
4. Continue until every page meets the threshold under the original test conditions.

## Rationale
The fixed harness prevents performance work from turning into anecdotal tuning. Measuring every route after each change catches local wins that quietly slow down another page.

## Implementation notes
Page load can mean server response, render completion, or a browser timing metric. Name the metric and hardware explicitly so the 50 ms target is reproducible and meaningful.
