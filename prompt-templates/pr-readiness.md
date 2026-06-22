---
description: "PR readiness"
---
/goal prepare the current change for pull-request review by auditing the diff, running required checks, and producing a reviewer-ready PR package with evidence.

## Inputs
- Branch or diff scope: <scope>
- PR objective: <objective>
- Required checks and review standards: <checks>
- Linked issue, ticket, or design doc: <refs>

## Deliverables
- Diff summary organized by user-visible behavior, implementation, tests, and docs.
- Readiness checklist covering scope, tests, docs, migrations, config, security, and rollback considerations.
- Minimal in-scope fixes for readiness blockers when authorized.
- Draft PR title and body.

## Verification surface
- Cite changed files, tests, commands, screenshots, logs, docs, or issue references used as evidence.
- Run relevant checks and include exact outcomes; explain any skipped check.
- Surface unresolved review risks so a reviewer can judge readiness from the conversation.

## Constraints
- Do not hide known issues or overstate test coverage.
- Avoid unrelated cleanup and do not rewrite history, commit, push, open the PR, or deploy unless explicitly requested.
- Preserve project PR conventions and templates if they exist.

## Iteration policy
- Inspect the diff first, identify readiness gaps, fix only authorized blockers, rerun affected checks, then draft the PR package.
- If the diff is too broad to review safely, stop and propose a smaller split.

## Completion audit
Before declaring done, confirm:
- The PR objective is matched by the diff and no unrelated changes are included without explanation.
- Required checks are pass, fail, skipped-with-reason, or blocked.
- The PR body includes evidence, risks, and reviewer guidance.

## Blocked stop condition
Stop and ask for direction if required checks need missing environments, the branch has unrelated work, secrets are exposed, or release/rollback risk is unclear.

## Final artifact
Return a `PR Readiness Package` with: readiness verdict, diff summary, verification outcomes, risks, reviewer notes, and draft PR title/body.
