---
description: "Easy Onboarding Loop"
category: "Evaluation"
author: "Eric Lott"
library_number: "039"
published: "2026-06-20"
modified: "2026-06-20"
---

# Easy Onboarding Loop

## Prompt
Act like a first-time user of {{product}}. Start at the real entry point in a clean session with no saved login, site data, remembered route, or hidden setup. Complete onboarding using only visible guidance and record obstacles. Fix the worst one with the smallest change that preserves every security, access, and product requirement. Discard the session and retry. Stop after one uninterrupted success, no safe fix, blocked access, or required approval. Return the path, changes, evidence, and blockers.

## When to use
Use this when new users may face unclear instructions, hidden assumptions, difficult recovery, or unnecessary steps that experienced users no longer notice because their accounts and browsers remember earlier setup.

## Success criteria
- A first-time user can complete onboarding in one uninterrupted clean session.
- The full experience succeeds from the real starting point without saved browser state, secret setup, guessed routes, or manual repairs, and every real requirement remains intact.

## Steps
1. Open a clean session with no saved login, cookies, site storage, remembered web address, secret setup, or repair left over from an earlier attempt.
2. Begin where a real newcomer begins, complete the onboarding steps using only visible guidance, and record anything unclear, unexplained, unnecessarily difficult, or impossible to recover from.
3. Fix the most harmful obstacle with the smallest change that preserves security, access, legal, onboarding, and product requirements.
4. Throw away the session and retry the entire experience until one uninterrupted clean pass succeeds or no safe progress is possible, access is blocked, or approval is required.

## Rationale
Saved logins and remembered setup hide problems from experienced users. Starting over after every fix shows whether the product itself now explains the path, while preserving real requirements prevents an easier experience from weakening security or access controls.

## Implementation notes
A clean session means a new private browser or another isolated environment with no cookies, login, local storage, cache, or remembered route. Start where a newcomer would actually arrive and follow only the guidance the product exposes.
