---
description: "Plan a cross-repo project from an issue"
---
/goal turn the provided issue into an implementation-ready cross-repo project plan without changing code or mutating systems, verified by evidence for every claimed repo, surface, owner/contact, entitlement, local rule, check, dependency, risk, and timeline assumption.

## Inputs
- Issue URL or pasted issue: <issue>
- Organization/project context: <context>
- Known repos, services, product surfaces, or teams: <known-scope>
- Planning horizon, deadline, or release target: <timeline>
- Access limits or systems that must remain read-only: <limits>

## Deliverables
- Issue evidence extraction: title, labels, affected users/surfaces, linked tickets/PRs, screenshots, logs, error strings, feature flags, entitlement names, rule names, mentioned teams/people, and unknowns.
- Repo and surface map separating confirmed, likely, and unverified candidates.
- Checks map covering CI, tests, typecheck/lint/build, contract checks, manual flows, dashboards/logs, rollout gates, and local validation rules.
- Entitlement, permission, feature-flag, policy, and local-rule map with source references and execution impact.
- Ownership map separating code ownership, product/domain ownership, operational support, approvers, and proposed Slack/channel contacts.
- Dependency graph with critical path, parallelizable work, decision gates, and sequencing constraints.
- Small-task execution timeline where each task is independently assignable and has prerequisites, validation, owner/contact, deliverable, and unblock condition.

## Investigation order
1. Extract facts and searchable entities from the issue itself before searching elsewhere.
2. Identify highest-risk unknowns first: entitlement/permission changes, production-impacting surfaces, cross-repo contracts, unclear owners, missing checks, rollout dependencies, and local-rule exceptions.
3. Search for candidate repos and product surfaces using extracted entities, linked artifacts, docs, ownership metadata, routing/API contracts, feature flags, entitlement/rule names, and existing examples.
4. Map checks and validation paths from repo docs, CI config, package/test scripts, contract tests, dashboards, runbooks, and manual QA paths.
5. Map owners and contacts from CODEOWNERS, repo metadata, docs, recent maintainers, team directories, support rotations, and referenced channels.
6. Build the dependency graph before assigning dates; classify each dependency as blocking, parallelizable, optional, or waiting-on-owner.
7. Convert the graph into a phased timeline and task list only after evidence and blockers are recorded.

## Verification surface
- Cite concrete evidence for every confirmed or likely repo, surface, owner/contact, entitlement, local rule, check, dependency, risk, and timeline assumption.
- Prefer issue fields, linked tickets/PRs, source files, CODEOWNERS, ownership metadata, repo docs, CI/test config, entitlement/rule definitions, routing/API contracts, feature-flag definitions, runbooks, dashboards/log references, existing examples, and accessible internal docs.
- Mark missing access, conflicting evidence, stale docs, inferred ownership, and guessed timeline estimates as unverified instead of smoothing them over.
- Do not edit code, open PRs, message people, change permissions, deploy, run destructive commands, or mutate external systems unless the user explicitly asks later.

## Constraints
- This is planning and discovery only; stop before implementation.
- Distinguish confirmed facts from likely leads and unverified assumptions.
- Distinguish code ownership from product/domain ownership, operational support, and approval authority.
- Do not collapse cross-repo work into one vague task; split by repo/surface/check/owner boundary.
- Do not assign dates before deriving dependencies and earliest-start conditions.

## Decision log
Maintain a decision log with one row per decision or assumption:
- Decision or assumption.
- Evidence and alternatives considered.
- Owner/approver/contact if known.
- Confidence: high, medium, low, or blocked.
- Whether it blocks planning, implementation, validation, rollout, or communication.

## Timeline task contract
For each task, include:
- Task name and repo/surface.
- Why it exists and what evidence supports it.
- Owner/contact and approval path.
- Earliest start condition and dependencies.
- Expected duration range and confidence.
- Required checks, entitlements/local rules, and validation steps.
- Deliverable and what becomes unblocked when complete.
- Status: ready, blocked, waiting-on-owner, parallelizable, optional, or decision-needed.

## Completion audit
Before declaring done, confirm:
- Every claim has evidence or is explicitly marked unverified.
- Every high-risk unknown is resolved, downgraded with evidence, or listed as a blocker.
- The dependency graph supports the timeline and no date/task ordering is invented.
- Each small task is assignable without rereading the whole investigation.
- Every blocker states what is unknown, why it matters, evidence checked, likely owner/contact, and exact decision or access needed.

## Blocked stop condition
Stop and ask for direction if required issue context is missing, ownership evidence conflicts, access is unavailable, an entitlement/local rule cannot be interpreted, a production-impacting decision is needed, or the plan would require contacting people or mutating systems to continue.

## Final artifact
Return a `Cross-Repo Project Plan` with:
1. Issue summary
2. Confirmed facts
3. Search terms and extracted entities
4. Open questions and blockers
5. Repo and surface map
6. Checks/tests/validation map
7. Entitlement, permission, feature-flag, and local-rule map
8. Owners, approvers, and contacts with evidence
9. Dependency graph or ordered dependency list
10. Decision log
11. Critical path and phased timeline
12. Small task breakdown
13. Next actions requiring approval
