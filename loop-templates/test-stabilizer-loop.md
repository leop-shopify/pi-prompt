---
description: "Test Stabilizer Loop"
category: "Engineering"
author: "hungtv27 (@hungtv27)"
library_number: "044"
published: "2026-06-20"
modified: "2026-06-20"
---

# Test Stabilizer Loop

## Prompt
Run {{test suite}} {{N}} times under the same conditions and list tests whose result changes. Fix the most frequent flake at its root cause—shared state, timing, ordering, or an external dependency—never with a blind sleep or retry. Run that test {{N}} times, then rerun the full suite. Repeat until {{N}} consecutive full-suite runs pass, progress stalls, or approval is required. Return each flake, root cause, fix, evidence, and justified quarantine.

## When to use
Use this when a test suite produces inconsistent results across otherwise comparable runs and the failures may come from shared state, timing, ordering, or external dependencies.

## Success criteria
- The full test suite passes for the required consecutive-run streak.
- The repaired test passes repeatedly, {{N}} consecutive full-suite runs are green under the recorded conditions, and no blind sleep or retry hides an unresolved cause.

## Steps
1. Choose the test suite, the required run count, and the conditions that must stay fixed, then run the complete suite repeatedly and record every inconsistent test.
2. Select the most frequent flake, reproduce it as narrowly as practical, and identify the underlying shared-state, timing, ordering, or dependency failure.
3. Fix the test or product code without adding a blind sleep or retry, then run the affected test repeatedly before returning to the complete suite.
4. Repeat until the required number of consecutive full-suite runs pass, progress stalls, or approval is needed, and report every root cause, fix, quarantine, and remaining blocker.

## Rationale
Repeated runs turn intermittent failures into measurable evidence. Repairing the most frequent flake first and requiring a full-suite streak prevents a local fix from hiding another source of instability.

## Implementation notes
Choose {{N}} before the first run and keep the environment comparable. Quarantine is a visible temporary containment step, not proof of repair; record its reason and do not report the suite as fully stabilized while unresolved tests remain quarantined.
