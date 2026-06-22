---
description: "Logging Coverage Loop"
category: "Engineering"
author: "Matthew Berman"
library_number: "007"
published: "2026-06-16"
modified: "2026-06-17"
---

# Logging Coverage Loop

## Prompt
Review the system's logging and add missing coverage until every important path produces useful, tested logs.

## When to use
Use this when important user flows, service boundaries, background jobs, or failure paths are difficult to trace because the system's logging is incomplete or inconsistent.

## Success criteria
- Every important path emits useful, tested logs.
- Representative success and failure tests prove coverage without exposing sensitive data.

## Steps
1. Inventory the important paths and define the event, outcome, severity, correlation context, and fields each one should emit.
2. Add structured logs to uncovered paths without duplicating events or adding low-value noise.
3. Add tests for successful and failed outcomes, then inspect representative emitted logs for useful context.
4. Verify redaction and repeat until every important path has tested coverage or a documented reason not to log.

## Rationale
Treating logging as testable coverage turns observability from scattered statements into a reviewable system requirement. Inspecting emitted events catches gaps that source review alone misses.

## Implementation notes
Never log credentials, tokens, secrets, or sensitive personal data. Prefer stable event names and structured fields over interpolated prose.
