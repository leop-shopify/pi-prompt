---
description: "Ground Truth Audit Loop"
category: "Engineering"
author: "Mohamed (@aivibecode)"
library_number: "048"
published: "2026-06-21"
modified: "2026-06-21"
---

# Ground Truth Audit Loop

## Prompt
Audit {{project}} from its actual code and configuration, not framework assumptions. For architecture, platform compatibility, security, privileged areas, performance, deployment, jobs, business logic, and code quality, record proved, no issue, weak, or N/A with direct evidence; verify external limits from current primary sources and calculate numbers. Ask before changing code. Stop when every area is logged with severity, or return unverified areas as blocked. Finish with a plain-language overview and area-to-evidence table.

## When to use
Use this before trusting a project's security, correctness, platform compatibility, privileged surfaces, scheduled work, or operational assumptions and when the first task is audit rather than repair.

## Success criteria
- Every audit area has a current evidence-backed outcome and severity.
- The area-to-evidence table contains no silent gaps: each area is proved, no issue found, weak, N/A with a reason, or explicitly unverified and blocked.

## Steps
1. Discover the real language, framework, hosting platform, privileged surfaces, scheduled jobs, and deployment configuration from the scoped project itself.
2. Inspect each required area, tie conclusions to code or configuration, verify platform and library behavior from current primary sources, and calculate rather than estimate quantitative claims.
3. Record an outcome, evidence, and severity for every area, separating confirmed weaknesses from no-issue findings, justified N/A results, and unverified gaps.
4. Deliver the plain-language project overview and area-to-evidence table without changing code; stop complete only when every area is accounted for, otherwise return the blocked gaps.

## Rationale
Broad audits fail when they inherit framework defaults, rely on remembered limits, or omit quiet areas. A fixed evidence table forces the reviewer to prove, clear, exclude, or explicitly block every surface.

## Implementation notes
This loop is read-only. Ask before changing code, configuration, infrastructure, or production state. Use current primary documentation for external behavior, avoid exposing secrets from privileged areas, and do not turn missing access into a clean finding.
