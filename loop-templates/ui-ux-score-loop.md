---
description: "UI/UX Score Loop"
category: "Design"
author: "Hayden Cassar (@hcassar93)"
library_number: "036"
published: "2026-06-20"
modified: "2026-06-20"
---

# UI/UX Score Loop

## Prompt
Improve {{user flow, such as signup}} at {{URL}} until {{completion criterion}}. In a real browser, start each pass from fresh state—no saved login, cookies, or site data. Capture meaningful screens at the agreed sizes and modes, score them with one checklist, and improve the weakest safe area. Rerun the whole flow and keep only regression-free changes. Stop on success, two full passes with no gain, blocked access, or required approval. Return scores, screenshots, changes, and stop reason.

## When to use
Use this for a real task such as signup, login, onboarding, checkout, sharing, or creating and editing an item when the entire experience can be exercised in a browser and scored consistently.

## Success criteria
- The complete user task scores better without making another important screen worse.
- The final dashboard shows the same entry point, fresh browser state, screen sizes, modes, scoring rubric, screenshots, score changes, and stop reason for every retained improvement.

## Steps
1. Choose the user task, starting URL, success target, browser, clean-session rule, screen sizes, light or dark modes, screens to capture, and anything the agent must not change.
2. Complete the task once without editing; capture normal screens plus meaningful loading, error, recovery, and success states, then score each with the same user-focused rubric.
3. Improve the weakest safe area, start a new clean browser session, and repeat the entire task under the same conditions so before-and-after scores are comparable.
4. Keep only changes that improve the target without hurting another important screen; stop on success, two passes with no gain, blocked access, or required approval.

## Rationale
A clean browser session exposes problems that saved logins, cookies, and remembered settings can hide. Repeating the same task with the same scoring rubric makes the result comparable instead of relying on a vague impression that the interface feels better.

## Implementation notes
A flow means a user goal, such as signing up or checking out—not a guessed web address. A screen size is sometimes called a viewport; a mode may be light or dark. Judge what the user can see and do, not hidden console output.
