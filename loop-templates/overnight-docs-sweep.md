---
description: "Docs Sweep"
category: "Engineering"
author: "Matthew Berman"
library_number: "001"
published: "2026-06-12"
modified: "2026-06-18"
---

# Docs Sweep

## Prompt
Whenever a documentation pass is needed, review the codebase in full and make sure all documentation reflects the current implementation. Update stale documentation, verify the changes, then open a pull request.

## When to use
Use this whenever implementation changes may have left READMEs, setup guides, API references, examples, or runbooks behind.

## Success criteria
- Documentation matches the current implementation.
- Finish with a reviewable pull request.

## Steps
1. Review implementation changes since the last documentation pass.
2. Compare the repository's documentation with the code, configuration, commands, and behavior that now ship.
3. Update only stale material, then verify commands, links, and examples against the current repository.
4. Run the relevant checks and open a pull request that explains the documentation drift and the fixes.

## Rationale
The loop ties documentation to the implementation instead of relying on memory. Requiring a pull request creates a visible diff, a review point, and a durable record of what changed.

## Implementation notes
Keep the scope tied to real implementation changes. Do not rewrite accurate documentation just to create activity.
