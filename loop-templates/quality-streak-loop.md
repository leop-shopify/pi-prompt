---
description: "Quality Streak Loop"
category: "Evaluation"
author: "Matthew Berman"
library_number: "009"
published: "2026-06-16"
modified: "2026-06-17"
---

# Quality Streak Loop

## Prompt
Test realistic scenarios. When one fails, document it, add regression and benchmark coverage, fix it, and restart the streak. Stop after {{N}} successful cases in a row.

## When to use
Use this when product quality needs a strict consecutive-success bar and failures should permanently improve the test and benchmark suite.

## Success criteria
- The latest {{N}} realistic cases pass in a row.
- Every earlier failure is documented, fixed, and protected by regression and benchmark coverage.

## Steps
1. Define realistic scenarios, the quality bar, the value of {{N}}, and the evidence required for a pass.
2. Run cases one at a time under consistent conditions and preserve the result for review.
3. On any failure, document it, add regression and benchmark coverage, fix the cause, verify the fix, and reset the streak to zero.
4. Stop only after {{N}} consecutive cases meet the original quality bar.

## Rationale
Restarting the streak prevents isolated successes from hiding intermittent weaknesses. Converting each failure into durable coverage makes the evaluation stronger after every miss.

## Implementation notes
Choose {{N}} before the run and keep the scenario distribution representative. Do not lower the quality bar or avoid difficult cases to preserve the streak.
