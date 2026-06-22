---
description: "Ticket-to-PR-Ready Loop"
category: "Engineering"
author: "Hiten Shah"
library_number: "016"
published: "2026-06-18"
modified: "2026-06-19"
---

# Ticket-to-PR-Ready Loop

## Prompt
Take a ticket, bug report, failing behavior, or customer complaint and turn it into a review-ready patch. Reproduce the failure in the smallest representative environment, prove the root cause, make the smallest credible fix, and rerun the original reproduction plus relevant regression tests. If the issue cannot be reproduced after two serious attempts, say so. Do not fold unrelated refactors into the patch. Finish with the cause, changed files, before-and-after proof, risks, and pull-request summary.

## When to use
Use this when a real but loosely written ticket, bug report, or customer complaint needs to become a bounded engineering change with enough proof for a fast review.

## Success criteria
- The failure is fixed, verified, and ready for review.
- The issue reproduces before the fix, no longer reproduces afterward, and relevant regression checks pass.

## Steps
1. State the expected and actual behavior, then reproduce the failure in the smallest representative environment.
2. Trace the behavior to a root cause and confirm the causal link with evidence.
3. Implement the smallest credible fix, avoiding unrelated cleanup or hidden refactors.
4. Repeat the original reproduction, run relevant regression checks, and package the result for review.

## Rationale
The loop closes the gap between something being wrong and a reviewer being able to trust the patch. Reproduction, evidence, bounded scope, and a structured handoff remove the detective work from review.

## Implementation notes
Match the proof to the failure: screenshots or recordings for UI issues, tests or logs for backend behavior, benchmark deltas for performance, and sanitized traces for integrations.
