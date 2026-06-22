---
description: "Test coverage map"
---
/goal build a coverage map from important behaviors to existing tests, close authorized high-value gaps, and prove the remaining risk with explicit verification evidence.

## Inputs
- Feature, module, or release scope: <scope>
- Critical behaviors or requirements: <behaviors>
- Existing test commands and suites: <checks>
- Risk areas, incidents, or edge cases: <risks>

## Deliverables
- Behavior-to-test coverage table with owners/files where discoverable.
- Gap list ranked by user impact, defect risk, and implementation cost.
- Focused tests for authorized gaps, using existing project patterns.
- Recommendation for deferred coverage with rationale.

## Verification surface
- Cite test files, source files, fixtures, docs, commands, and coverage or failure output used as evidence.
- For each mapped behavior, identify the exact test or state `no direct test found` with search evidence.
- Run the relevant test command for any added or changed tests and surface the result.

## Constraints
- Do not chase percentage coverage at the expense of behavior coverage.
- Avoid brittle tests that assert implementation details unless the project already relies on that style.
- Do not install tools, rewrite the test framework, commit, push, or start services unless explicitly requested.

## Iteration policy
- Inventory behavior first, map current tests second, then add the smallest high-value tests if editing is in scope.
- If a test is flaky or environment-dependent, isolate the cause before adding more tests.

## Completion audit
Before declaring done, confirm:
- Every critical behavior is mapped to a test, a documented gap, or an out-of-scope note.
- Added tests fail for the intended reason when practical or are justified if not shown failing first.
- Relevant test commands and outcomes are recorded.

## Blocked stop condition
Stop and ask for direction if required environments, fixtures, credentials, external services, or product requirements are missing and would make the coverage map misleading.

## Final artifact
Return a `Test Coverage Map` with: behavior table, evidence references, added/updated tests, command outcomes, prioritized gaps, and residual risks.
