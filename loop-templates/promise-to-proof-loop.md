---
description: "Promise-to-Proof Loop"
category: "Evaluation"
author: "Felix Haeberle (@felixhaberle)"
library_number: "032"
published: "2026-06-20"
modified: "2026-06-20"
---

# Promise-to-Proof Loop

## Prompt
List every customer-facing promise {{product}} makes in marketing, documentation, demos, and AI answers. Compare each promise with current product behavior and evidence, then label it proven, partly proven, misleading, unsupported, outdated, or missing evidence. Fix or narrow the riskiest mismatch and rerun the affected check. Repeat until no high-risk unsupported promise remains. Ask before changing production or public copy. Return the promises, evidence, fixes, and decisions needed.

## When to use
Use this when what a product says it does may no longer match what it actually does across marketing, documentation, demos, support answers, or the live product.

## Success criteria
- Every high-risk customer promise is supported, narrowed, or waiting on an explicit decision.
- Each promise links to current evidence, and every high-risk mismatch is fixed, narrowed to what the product can prove, or clearly approval-gated.

## Steps
1. List the promises customers can see and rewrite each one as a concrete expectation, such as a feature working, a limit being honored, or an answer being accurate.
2. Compare each expectation with current product behavior, code, tests, documentation, examples, logs, or other direct evidence; do not guess.
3. Rank mismatches by the harm they could do to customer trust, then fix the riskiest one or narrow the public promise to what the product can prove.
4. Rerun the same check and repeat until no high-risk unsupported promise remains, progress is blocked, or the next action needs approval.

## Rationale
This turns a vague question—can customers trust what we say?—into a list of promises that can each be checked. Fixing one risky mismatch at a time keeps the product and its public explanation aligned without turning the audit into an uncontrolled rewrite.

## Implementation notes
Evidence can include live product behavior, tests, documentation, logs, screenshots, or reproducible examples. A promise may be supported, narrowed, or removed; the product does not always need to change. Production changes and public publication still require approval.
