---
description: "Pixel-Safe CSS Trim Loop"
category: "Design"
author: "Christian Katzmann"
library_number: "038"
published: "2026-06-20"
modified: "2026-06-20"
---

# Pixel-Safe CSS Trim Loop

## Prompt
Reduce the CSS styling code {{site}} sends to users without changing tested screens. First capture representative pages, sizes, themes, and interactions, and record the built CSS size. Treat coverage reports only as suggestions. Remove one declaration or rule, rebuild, and rerun screenshots and project checks. Keep it only if every screenshot is pixel-identical and built CSS is smaller; otherwise revert. Stop when no supported candidate remains, progress stalls, or approval is required. Return reduction, evidence, and untested states.

## When to use
Use this when a website's styling files may contain unused declarations, duplicated rules, or old overrides and representative pages and interactions can be captured in repeatable screenshots.

## Success criteria
- The delivered stylesheet is smaller while every tested screen remains pixel-identical.
- The same project checks and screenshots pass after each retained deletion, the built CSS file sent to users is smaller, and untested browsers, screens, or interactions remain explicit risks.

## Steps
1. Before deleting styling code, list representative pages, screen sizes, light and dark modes, conditional content, hover and keyboard-focus states, and other important variants; capture screenshots and record the final built CSS size.
2. Use a CSS coverage report to suggest declarations or rules that may be unused, then remove one candidate from the maintainable source file.
3. Rebuild, run project checks, and recreate every screenshot; keep the deletion only when all images are pixel-identical and the built CSS is smaller, otherwise revert it.
4. Repeat until no well-supported candidate remains, repeated attempts save nothing, the screenshots cannot cover the affected behavior, or approval is required.

## Rationale
Screenshots taken before cleanup preserve the current appearance as the standard. Exact image comparison and one deletion per round catch visual changes that an automated coverage report cannot understand, including rules that matter only because of their order.

## Implementation notes
CSS is the code that controls a page's appearance. A coverage report can suggest that a rule was not used during one visit, but it cannot prove the rule is unnecessary everywhere. Add uncertain browsers and interaction states before deleting their styles.
