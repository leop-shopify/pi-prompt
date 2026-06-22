---
description: "Artifact-to-Skill Loop"
category: "Evaluation"
author: "Hiten Shah (@hnshah)"
library_number: "045"
published: "2026-06-20"
modified: "2026-06-20"
---

# Artifact-to-Skill Loop

## Prompt
Turn {{artifact}} into a skill, playbook, or procedure. Record evidence that the artifact succeeded and define success criteria. Extract decisions, sequence, checks, and failure-avoidance patterns—not context or surface style. Remove sensitive material. Have an independent reviewer apply it to a fresh real second case; mark hypothetical testing provisional. Revise at most twice. Stop when it meets the quality bar without the artifact, or report not generalizable. Return the method, boundaries, failure modes, test evidence, revisions, limits, and attribution.

## When to use
Use this when a completed artifact has evidence of success, appears to contain a repeatable method, and similar work is likely to recur.

## Success criteria
- The extracted method succeeds on a fresh second case without the original artifact.
- An independent reviewer applies the reusable version under criteria defined before extraction, and the second result meets the source artifact's demonstrated quality bar or the method is honestly marked provisional or not generalizable.

## Steps
1. Confirm that the source artifact has credible evidence of success, define the quality criteria it met, and exclude sensitive or proprietary material that should not be transferred.
2. Separate the durable decisions, sequence, checks, standards, and failure-avoidance patterns from one-off facts, tools, and surface style.
3. Write the method as a standalone skill, playbook, or procedure with inputs, boundaries, steps, quality standards, failure modes, attribution, and clear terminal states.
4. Have an independent reviewer apply it to a fresh real case, revise no more than twice, and return either a reusable version with test evidence or an honest provisional, blocked, or not-generalizable result.

## Rationale
Strong outputs often get saved while the method that produced them disappears. Extracting the decisions and checks makes that knowledge reusable, while a fresh second-case test distinguishes a transferable process from imitation of one polished example.

## Implementation notes
Do not infer success from polish alone, copy confidential material, or treat a hypothetical test as final proof. Preserve attribution, define the quality bar before extraction, and stop honestly when hidden context makes the method impossible to generalize.
