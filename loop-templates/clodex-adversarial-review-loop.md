---
description: "Clodex Adversarial Review Loop"
category: "Engineering"
author: "Lukas Kucinski"
library_number: "019"
published: "2026-06-18"
modified: "2026-06-19"
---

# Clodex Adversarial Review Loop

## Prompt
Run /clodex {{task}} think hard --max-iter 5 --threshold medium. Claude plans the task, implements it, opens a pull request, asks Codex for an adversarial review, fixes findings above the accepted severity, and repeats. Keep the branch, PR, findings, verdict, and iteration state resumable. Stop when Codex approves, only accepted findings remain, progress stalls, or the iteration cap is reached. Never describe an errored or exhausted run as approved. Finish with the PR, checks, verdict, and remaining findings.

## When to use
Use Clodex when Claude is building a meaningful code change and Codex should independently review each repair round.

## Success criteria
- The pull request reaches the configured review bar.
- Codex approves it or only explicitly accepted findings remain; errors, stalls, and exhausted limits are reported as such.

## Steps
1. Choose the task, thinking level, maximum iterations, and highest acceptable finding severity.
2. Have Claude plan, implement, verify, and open the pull request through Clodex.
3. Run the Codex adversarial review, fix blocking findings, push, and review again.
4. Persist state across rounds and finish with the verdict, remaining findings, checks, and pull-request link.

## Rationale
Clodex separates the Claude builder from the Codex reviewer and turns review feedback into a bounded repair loop. Persisted state keeps the work resumable without treating an interruption as approval.

## Implementation notes
The source implementation uses Clodex with Codex as the adversarial reviewer. Treat the severity threshold as a ceiling for acceptable findings, not a minimum severity to inspect.
