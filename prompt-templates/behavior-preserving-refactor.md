---
description: "Behavior-preserving refactor"
---
/goal refactor the specified code while preserving observable behavior, then prove equivalence with characterization evidence and relevant checks.

## Inputs
- Refactor target: <files, module, component, or pattern>
- Motivation: <readability, duplication, boundaries, performance without behavior change>
- Behaviors that must not change: <behaviors>
- Existing checks or characterization strategy: <checks>

## Deliverables
- Brief refactor plan naming invariants and risk points.
- Characterization evidence before changing behavior-sensitive code when practical.
- Minimal refactor that improves the target without expanding scope.
- Post-refactor verification proving preserved behavior.

## Verification surface
- Cite before/after files, tests, commands, snapshots, logs, UI screenshots, or API outputs used as evidence.
- Run existing relevant checks and any characterization checks added for the refactor.
- If behavior equivalence cannot be fully proven, state the unverified paths explicitly.

## Constraints
- Preserve public APIs, user-visible behavior, data formats, migrations, and error semantics unless the user approves a behavior change.
- Avoid opportunistic feature work, dependency changes, broad renames, commits, pushes, or deployments.
- Keep changes reversible and easy to review.

## Iteration policy
- Characterize first, refactor in small safe steps, run targeted checks after each material step, and stop if behavior drifts.
- If a behavior change seems necessary, pause and ask before implementing it.

## Completion audit
Before declaring done, confirm:
- Each planned invariant is preserved or an approved exception is documented.
- Tests or checks cover the touched behavior, or gaps are listed with risk.
- The diff excludes unrelated cleanup and accidental behavior changes.

## Blocked stop condition
Stop and ask for direction if behavior is undocumented and untestable, required fixtures are missing, or preserving behavior conflicts with the requested design.

## Final artifact
Return a `Behavior-Preserving Refactor Report` with: plan, invariants, changed files, verification outcomes, equivalence evidence, and residual risks.
