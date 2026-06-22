---
description: "Fresh-Clone Loop"
category: "Engineering"
author: "0xUmbra"
library_number: "025"
published: "2026-06-18"
modified: "2026-06-19"
---

# Fresh-Clone Loop

## Prompt
Clone {{repository}} into a disposable environment and follow only its README to the documented ready state, such as running the app or building the package. When a step fails or assumes missing knowledge, record the gap, fix the setup or documentation issue, discard the environment, and start again. Carry no dependencies, configuration, credentials, or repairs between attempts. Stop when one uninterrupted fresh clone reaches that state, progress stalls, or {{budget}} ends. Return exact commands, gaps closed, and remaining blockers.

## When to use
Use this to test whether a repository's onboarding instructions work in a clean environment without undocumented help.

## Success criteria
- A clean environment reaches the documented ready state using only the README.
- The final run uses only the onboarding guide and needs no unstated dependency, configuration, or manual repair.

## Steps
1. Create a disposable environment with no project dependencies or configuration carried over from another checkout.
2. Fresh-clone the repository and follow only the README, recording every missing step, hidden assumption, and failure.
3. Fix the smallest setup or documentation gap, discard the environment completely, and begin again.
4. Repeat until one clean run reaches the documented ready state without intervention, then report the exact commands and gaps closed.

## Rationale
Destroying the environment after each repair prevents local state from hiding the next problem. The final uninterrupted run is direct evidence that the README, not the operator's memory, is sufficient.

## Implementation notes
Use an isolated disposable environment and review the repository before executing it. Never copy personal credentials into the test environment or run untrusted setup scripts on a production host.
