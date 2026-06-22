---
description: "Full Product Evaluation Loop"
category: "Evaluation"
author: "Matthew Berman"
library_number: "010"
published: "2026-06-16"
modified: "2026-06-21"
---

# Full Product Evaluation Loop

## Prompt
Build sanitized, production-scale local data under production-like settings. Inventory every user-facing feature, role, route, button, input, modal, state, and workflow; define documented acceptance criteria and finite risk-based edge cases for each. Test as a real user, logging every bug with reproduction evidence. Review findings for shared causes and dependencies; implement coherent fixes with regression tests, then rerun the full inventory. Stop at a clean pass or blocked handoff. Ask before production, sensitive data, or destructive actions.

## When to use
Use this for an exhaustive, end-to-end application QA pass when a production-like local environment and complete interactive-surface coverage matter more than a narrow regression or sample of major features.

## Success criteria
- Every inventoried product surface meets its documented acceptance criteria.
- The final full regression run covers every inventoried surface and its finite risk-based edge cases in the production-like local environment, with each reproducible bug fixed and backed by evidence.

## Steps
1. Build a sanitized or synthetic production-scale local dataset, mirror safe production settings, and record unavoidable differences.
2. Inventory every user-facing feature, role, route, control, state, and workflow; define documented acceptance criteria and a finite risk-based edge-case set for each item.
3. Exercise every inventory item as a real user under its normal and defined edge-case conditions, logging each bug immediately with reproducible evidence.
4. Review the complete bug set for shared causes, dependencies, and conflicting fixes, then implement the smallest coherent solution with regression coverage.
5. Rerun affected paths and the complete inventory; stop only at a clean full pass or an explicit blocked handoff.

## Rationale
A finite surface inventory prevents major controls and states from disappearing behind a few happy-path scenarios. Reviewing all findings before fixing them exposes shared causes and interactions, while the final full run catches changes that repair one path but weaken another.

## Implementation notes
Do not copy secrets or sensitive production data into the local environment, touch production without approval, or count an untested or blocked surface as passing. Preserve the inventory, bug log, environment differences, and final evidence for review.
