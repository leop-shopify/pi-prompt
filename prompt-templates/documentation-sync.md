---
description: "Documentation sync"
---
/goal synchronize documentation with the current product or code behavior, verify examples where practical, and leave an evidence-backed docs change report.

## Inputs
- Documentation scope: <README, docs, API reference, runbook, changelog, help text>
- Source-of-truth code, behavior, product decision, or issue: <refs>
- Audience: <users, developers, operators, support>
- Verification commands or examples: <checks>

## Deliverables
- Inventory of docs that are stale, missing, duplicated, or accurate.
- Minimal documentation updates that match verified behavior when editing is authorized.
- Updated examples, commands, screenshots, or API notes where needed.
- List of unresolved documentation questions.

## Verification surface
- Cite source files, CLI output, tests, screenshots, docs pages, config, or product references used as evidence.
- Verify commands/examples when safe; otherwise mark them unverified with the reason.
- Distinguish documented behavior from inferred behavior.

## Constraints
- Do not document aspirational behavior as current behavior.
- Preserve existing terminology and doc structure unless inconsistency is part of the issue.
- Do not install packages, start services, publish docs, commit, push, or deploy unless explicitly requested.

## Iteration policy
- Compare docs to source-of-truth first, patch the smallest stale sections, then re-read the affected docs for consistency.
- If code and product docs disagree, stop changing claims until the intended source of truth is clarified.

## Completion audit
Before declaring done, confirm:
- Each changed doc claim is backed by code, test, command, screenshot, or explicit user decision.
- Examples and commands are verified or clearly marked unverified.
- Cross-links, headings, and references remain coherent.

## Blocked stop condition
Stop and ask for direction if the intended behavior is ambiguous, source material is missing, publishing access is required, or docs changes would imply an unapproved product decision.

## Final artifact
Return a `Documentation Sync Report` with: docs changed, evidence references, verified examples, unresolved questions, risks, and recommended follow-ups.
