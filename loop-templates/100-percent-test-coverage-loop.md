---
description: "100% Test Coverage Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "005"
published: "2026-06-13"
modified: "2026-06-17"
---

# 100% Test Coverage Loop

## Prompt
Add tests until we have 100% test coverage.

## When to use
Use this when 100% coverage is an explicit project requirement and the repository has a trustworthy coverage command, clear exclusions, and a test suite that can be run repeatedly.

## Success criteria
- The full test suite passes at 100% coverage.
- Use the project's coverage report as the source of truth.

## Steps
1. Run the complete test suite with coverage and save the baseline report.
2. Prioritize uncovered branches and behavior by risk instead of file order.
3. Add tests that assert meaningful outcomes, failure paths, and boundary conditions.
4. Repeat until the full suite passes and the configured coverage report reaches 100%.

## Rationale
A concrete coverage target gives the agent a measurable stopping condition and makes skipped code visible. Risk-first ordering keeps the work focused on behavior that matters.

## Implementation notes
Coverage measures which code ran, not whether the assertions are good. Review test quality, avoid tests that only execute lines, and keep justified generated-code or platform exclusions explicit.
