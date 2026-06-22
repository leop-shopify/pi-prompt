---
description: "Production Error Sweep"
category: "Engineering"
author: "Matthew Berman"
library_number: "004"
published: "2026-06-12"
modified: "2026-06-18"
---

# Production Error Sweep

## Prompt
Review our production logs for errors. If you find an actionable issue, trace it to its root cause, fix it, verify the fix, and open a pull request. If no actionable errors are present, stop without making changes.

## When to use
Use this as a scheduled reliability pass when an agent can read production telemetry, trace failures into the repository, run the relevant tests, and prepare a reviewable fix.

## Success criteria
- Actionable production errors are fixed and verified.
- Finish with a pull request, or stop when no actionable errors are present.

## Steps
1. Review the agreed production log window and group repeated symptoms into likely incidents.
2. Separate actionable product errors from expected noise, transient upstream failures, and already-known issues.
3. Trace each actionable error to a root cause, implement the smallest appropriate fix, and verify it with focused checks.
4. Open a pull request for each verified fix. If the logs are clean, stop without making changes.

## Rationale
The loop converts passive log review into a closed reliability workflow. It requires a root cause, verified change, and review artifact instead of stopping at a list of errors.

## Implementation notes
Treat logs as sensitive production data. Do not copy credentials, tokens, personal information, or private payloads into prompts, pull requests, or chat messages.
