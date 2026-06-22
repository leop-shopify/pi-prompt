---
description: "Release readiness"
---
/goal assess release readiness for the specified candidate, resolve authorized blockers, and produce a go/no-go release report backed by verifiable evidence.

## Inputs
- Release candidate, version, or commit range: <candidate>
- Release scope and acceptance criteria: <scope>
- Required checks, environments, and approvals: <checks>
- Known risks, migrations, flags, or rollback needs: <risks>

## Deliverables
- Release checklist covering build, tests, docs, migrations, config, observability, security, support, and rollback.
- Verification of required gates with exact evidence.
- Minimal fixes for in-scope release blockers when authorized.
- Go/no-go recommendation and launch notes.

## Verification surface
- Cite commands, CI runs, changelog entries, version files, migration status, dashboards, logs, screenshots, and docs used as evidence.
- Mark each gate pass, fail, skipped-with-reason, waived, or blocked.
- Do not recommend go unless the evidence visible in the conversation supports it.

## Constraints
- Do not deploy, tag, publish, migrate production data, or notify customers unless explicitly requested.
- Avoid last-minute broad refactors; only fix release blockers within scope.
- Preserve versioning, changelog, and release conventions already present in the project.

## Iteration policy
- Inventory release requirements first, run/read gates, fix the highest-severity authorized blocker, rerun the affected gate, then reassess go/no-go.
- If an approval or environment is missing, record it as blocked rather than assuming success.

## Completion audit
Before declaring done, confirm:
- Every required gate has a status and evidence link or excerpt.
- Version/changelog/docs/release notes are consistent or gaps are listed.
- Rollback and monitoring notes are present for any user-impacting release.

## Blocked stop condition
Stop and ask for direction if release requires production credentials, destructive migrations, unavailable approvers, external publishing, or risk acceptance beyond your authority.

## Final artifact
Return a `Release Readiness Report` with: go/no-go, checklist table, verification evidence, fixes made, release notes, rollback plan, and blocked items.
