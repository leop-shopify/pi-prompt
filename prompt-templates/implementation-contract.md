---
description: "Implementation contract"
---
/goal turn the requested change into a scoped implementation contract, execute it if authorized, and prove the final state with concrete verification evidence.

## Inputs
- Requested change: <change>
- In scope: <scope>
- Out of scope: <non-goals>
- Reference files, patterns, docs, or tickets: <refs>
- Required checks: <checks>

## Deliverables
- Short problem statement and measurable success condition.
- Implementation contract listing files/areas to inspect, files likely to change, risks, and non-goals.
- Minimal implementation aligned with existing project patterns when editing is authorized.
- Verification evidence showing the success condition was met.

## Verification surface
- Cite the files, functions, tests, commands, logs, screenshots, or docs used to verify the result.
- Run the requested checks; if a check is unavailable, explain why and provide the closest reliable evidence.
- Surface all verification output needed for a reviewer to judge success from the conversation.

## Constraints
- Explore before editing; do not code from assumptions when relevant project patterns are available.
- Keep the change minimal and avoid unrelated cleanup or architecture rewrites.
- Do not install packages, commit, push, deploy, start services, or make destructive data changes unless explicitly requested.

## Iteration policy
- Plan after exploration, implement in small steps, and rerun the narrowest relevant check after each material change.
- If verification fails, diagnose, make the smallest scoped fix, and rerun the failed check once before broadening.

## Completion audit
Before declaring done, confirm:
- The measurable success condition is satisfied or explicitly blocked.
- All changed files are listed and tied to the contract.
- Required checks passed, failed with evidence, or were unavailable with a reason.

## Blocked stop condition
Stop and ask for direction if the contract requires broader scope, missing decisions, unavailable secrets/environments, package changes, destructive operations, or risky migrations.

## Final artifact
Return an `Implementation Contract Report` with: contract, changes made, verification commands and outcomes, evidence references, risks, and follow-up options.
