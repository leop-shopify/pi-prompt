---
description: "Recovery Proof Loop"
category: "Operations"
author: "Eric Lott"
library_number: "049"
published: "2026-06-21"
modified: "2026-06-21"
---

# Recovery Proof Loop

## Prompt
For each required recovery scenario, randomly select an eligible real backup or recovery point and restore from zero in a disposable, isolated clean-room using only documented materials. Verify integrity, dependencies, representative reads and writes, and actual RPO and RTO. Repair one blocker, destroy the environment, and retry fresh. Stop when every scenario reaches its predefined consecutive-success streak or an exception is explicitly accepted. Never overwrite production, expose restored data, or initiate failover without approval.

## When to use
Use this when backup existence is not enough and the organization needs repeatable proof that required systems can be restored from documented materials within agreed recovery objectives.

## Success criteria
- Every required recovery scenario succeeds repeatedly from a real recovery point.
- Fresh clean-room restores satisfy integrity, dependency, representative read/write, RPO, and RTO checks under unchanged criteria, with failures preserved as regression drills and restored data destroyed securely.

## Steps
1. Define the required scenarios, eligible recovery points, unchanged success criteria, consecutive-success streak, isolation controls, and approval boundaries before restoring anything.
2. Randomly select one eligible real recovery point, restore from zero in a disposable clean-room using only documented materials, and measure actual RPO and RTO.
3. Verify checksums, control totals, referential integrity, keys, dependencies, and representative business reads and writes; preserve any failure as a regression drill.
4. Repair one recovery blocker, destroy the environment securely, and retry fresh until every scenario passes its streak or an unresolved exception is explicitly accepted.

## Rationale
A backup is only useful if a real recovery point can rebuild the required system under documented conditions. Random selection, fresh environments, measured objectives, and repeated success expose gaps that a one-time scripted restore can hide.

## Implementation notes
Restored production data remains sensitive even in a test environment. Never overwrite production, weaken isolation, expose restored data, or initiate production failover without explicit approval; preserve immutable evidence and securely destroy test data after each run.
