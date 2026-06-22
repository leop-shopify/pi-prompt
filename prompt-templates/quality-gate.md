---
description: "Quality gate"
---
/goal run a scoped quality gate for the current change or release candidate, fix authorized blockers, and produce a go/no-go decision backed by verification evidence.

## Inputs
- Candidate scope or diff: <scope>
- Required gates: <tests, typecheck, lint, build, security, accessibility, manual checks>
- Known risks or acceptance criteria: <risks>
- Fix authorization limits: <limits>

## Deliverables
- Quality gate checklist tailored to the project.
- Execution of required automated and manual checks that are available.
- Minimal fixes for in-scope blockers when authorized.
- Go/no-go recommendation with severity-ranked findings.

## Verification surface
- Record exact commands, test suites, logs, screenshots, status pages, or review findings used as evidence.
- For failures, include the failing excerpt, suspected cause, and whether it was fixed or deferred.
- Do not call the gate green unless all required evidence is surfaced or explicitly waived.

## Constraints
- Do not silently skip a required gate; mark skipped checks with reasons and risk.
- Avoid unrelated cleanup and keep fixes limited to gate blockers.
- Do not install packages, commit, push, deploy, or start services unless explicitly requested.

## Iteration policy
- Establish the checklist first, run gates, fix the highest-severity in-scope blocker, then rerun the affected gate.
- If multiple independent blockers appear, report the list before broad remediation.

## Completion audit
Before declaring done, confirm:
- Every requested gate is pass, fail, skipped-with-reason, or blocked.
- Every fix has a rerun or documented verification reason.
- Remaining findings are severity-ranked with owners or next actions when known.

## Blocked stop condition
Stop and ask for direction if a gate requires missing credentials/environments, destructive operations, dependency installs, broad refactors, or acceptance waivers.

## Final artifact
Return a `Quality Gate Report` with: go/no-go, checklist table, command/check outcomes, fixes made, unresolved blockers, waivers, and risks.
