---
description: "Test-Suite Speed Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "011"
published: "2026-06-16"
modified: "2026-06-17"
---

# Test-Suite Speed Loop

## Prompt
Optimize the test suite to run as quickly as possible without reducing coverage or changing behavior.

## When to use
Use this when slow tests are delaying local feedback or continuous integration and the project has stable commands for measuring runtime and coverage.

## Success criteria
- The suite is faster with no coverage or behavior regression.
- Repeatable timing, the full passing suite, and the original coverage report prove the result.

## Steps
1. Record the full-suite runtime, coverage, environment, worker settings, and repeatable timing method.
2. Profile the suite to find expensive setup, redundant work, poor isolation, unnecessary integration paths, or safe parallelization opportunities.
3. Make one optimization at a time, then rerun the full suite and compare timing, coverage, and behavior.
4. Stop at the agreed runtime target or diminishing-returns rule with all original checks still passing.

## Rationale
A fixed baseline prevents speed work from quietly trading away coverage or correctness. Profiling directs effort toward measured bottlenecks instead of speculative rewrites.

## Implementation notes
Define a runtime target or diminishing-returns rule before starting. Faster tests are not an improvement if they become flaky, order-dependent, or less representative.
