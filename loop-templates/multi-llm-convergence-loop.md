---
description: "Multi-LLM Convergence Loop"
category: "Evaluation"
author: "Donn Felker (@donnfelker)"
library_number: "034"
published: "2026-06-20"
modified: "2026-06-20"
---

# Multi-LLM Convergence Loop

## Prompt
Review {{plan, specification, document, or code change}} against {{quality bar}} for at most {{pass limit}} rounds. Have one of two genuinely different model families—AI systems from separate providers—review it. Verify each finding and apply only necessary fixes, then give the revised version to the other reviewer. Succeed only when both approve the same unchanged version. Stop at the limit, repeating disagreement (oscillation), unavailable review, or required approval. Return the final work, round log, verdict, and disagreements.

## When to use
Use this when an important plan, specification, design, document, or code change benefits from two independent AI perspectives rather than one model reviewing its own blind spots.

## Success criteria
- Two different AI model families approve the exact same version.
- The final two clean reviews come from different model families with no edit between them; a pass limit, repeating disagreement, unavailable reviewer, or approval boundary is reported as a stall instead of consensus.

## Steps
1. Choose the work being reviewed, define what counts as acceptable, set a maximum number of rounds, and gather the source material reviewers should trust.
2. Give the current version to the first AI model family, check whether each finding is valid, apply only necessary fixes, and record the round.
3. Give the resulting version to the other model family; if either reviewer causes another edit, both must review the new version again.
4. Finish only when both independently approve one unchanged version; otherwise stop at the round limit, repeated back-and-forth, reviewer failure, or an approval boundary.

## Rationale
Different model families can notice different problems. Requiring both to approve the exact same version prevents a clean review of an older draft from being counted as approval of a newer one, and the round log shows how the agreement was reached.

## Implementation notes
A model family means a genuinely separate model lineage, such as a Codex/OpenAI reviewer and a Claude/Anthropic reviewer—not two prompts sent to the same underlying model. With only one family, label the result a single-model review and do not claim consensus.
