---
description: "Post-Release Baseline Loop"
category: "Operations"
author: "Matthew Berman"
library_number: "015"
published: "2026-06-16"
modified: "2026-06-17"
---

# Post-Release Baseline Loop

## Prompt
After current releases finish, run the standard benchmarks and record the results as the new baseline.

## When to use
Use this immediately after a release when future regressions or improvements need to be measured against the exact version now in production.

## Success criteria
- The new baseline belongs to the completed release.
- Revision, environment, benchmark version, conditions, and results are recorded together.

## Steps
1. Confirm every in-scope release is complete and record the production revision or artifact identity.
2. Run the standard benchmark suite under its documented environment, data, warm-up, and repetition rules.
3. Investigate invalid or unstable runs, then rerun only under the same documented conditions.
4. Store the final results with the release identity and benchmark metadata, and mark them as the new comparison baseline.

## Rationale
Tying the baseline to a verified release creates a trustworthy reference point for later performance and quality work. Recording the conditions prevents unrelated environment changes from masquerading as product changes.

## Implementation notes
Do not overwrite the previous baseline until the release identity and benchmark run are verified. Keep historical baselines available for trend analysis.
