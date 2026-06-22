---
description: "Revolve Versioned Experiment Loop"
category: "Evaluation"
author: "Agent Zero"
library_number: "029"
published: "2026-06-19"
modified: "2026-06-19"
---

# Revolve Versioned Experiment Loop

## Prompt
Use Revolve to improve a support prompt, code path, or testable subject. In revolve/, define the goal and {{budget}}, freeze the tests and scoring, checkpoint the current version, and record a baseline. Each round, test one hypothesis; keep only a clear, regression-free win. If the evaluation changes, open a new revision and rerun the baseline. Ask before changing live files. Stop on success, no progress, a blocker, or exhausted budget. Return the best checkpoint, comparisons, rollback, and next action.

## When to use
Use Revolve to improve a prompt, policy, workflow, model configuration, code path, or dataset when experiments must remain comparable and resumable across sessions.

## Success criteria
- The best Revolve checkpoint wins within one evaluation revision.
- The incumbent and candidates have comparable recorded runs, accepted changes pass every guard, rollback is available, and live promotion has approval.

## Steps
1. Create or resume revolve/, define the objective and permissions, freeze an evaluation revision, checkpoint the incumbent, and record its baseline.
2. Choose one evidence-backed hypothesis, create a candidate checkpoint, and test it under the unchanged revision.
3. Promote internally only on a meaningful guard-safe win; if the evaluation changes, open a new revision and rerun the incumbent.
4. Stop on a named condition, and require explicit approval plus verification before changing live files.

## Rationale
Revolve's revision boundaries prevent scores from different tests or rubrics from being compared as equivalent. Checkpoints and an internal-before-live promotion boundary keep long-running research resumable and reversible.

## Implementation notes
The source examples include improving CLI error messages, reducing image-export latency, tuning a support-assistant prompt, and hardening a parser. Replace the subject and metric, but keep the revision, checkpoint, and rollback discipline.
