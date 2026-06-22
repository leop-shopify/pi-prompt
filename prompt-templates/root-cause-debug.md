---
description: "Root-cause debug"
---
/goal identify the root cause of the reported defect, apply the smallest authorized fix, and prove the fix with a regression-focused verification check.

## Inputs
- Symptom or error: <symptom>
- Reproduction steps or failing check: <steps>
- Expected behavior: <expected>
- Recent changes, logs, or affected files: <refs>
- Constraints on fixes or environments: <limits>

## Deliverables
- Reproduction or best-effort confirmation of the defect.
- Root-cause explanation tied to code, config, data, dependency behavior, or environment evidence.
- Minimal fix when editing is authorized.
- Regression check that would have caught the defect.

## Verification surface
- Show the failing evidence before the fix when reproducible.
- Cite exact files, stack traces, logs, commands, tests, or state transitions used to isolate the cause.
- Show the passing evidence after the fix, or explain why the defect could not be reproduced.

## Constraints
- Do not mask symptoms without explaining the causal chain.
- Preserve unrelated behavior and avoid broad refactors while debugging.
- Do not install packages, reset data, restart services, commit, push, or deploy unless explicitly requested.

## Iteration policy
- Reproduce or narrow first, form one hypothesis at a time, test it, then patch only the confirmed cause.
- If the first fix fails verification, revert or adjust only the scoped change and rerun the regression check.

## Completion audit
Before declaring done, confirm:
- The observed symptom, root cause, and fix are linked by evidence.
- A regression check exists, was added, or is documented as unavailable.
- All remaining risks and unverified environments are listed.

## Blocked stop condition
Stop and ask for direction if reproduction requires unavailable credentials/data, production-only actions, destructive resets, large dependency changes, or ambiguous expected behavior.

## Final artifact
Return a `Root Cause Debug Report` with: symptom, reproduction evidence, root cause, fix summary, regression verification, changed files, and residual risks.
