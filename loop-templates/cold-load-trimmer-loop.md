---
description: "Cold-Load Trimmer Loop"
category: "Engineering"
author: "Christian Katzmann"
library_number: "037"
published: "2026-06-20"
modified: "2026-06-20"
---

# Cold-Load Trimmer Loop

## Prompt
Reduce the data {{web app}} downloads before its first screen appears. First record passing tests, mobile and desktop screenshots, and compressed transferred bytes—the data actually downloaded. Use the build report only to suggest candidates. Defer, compress, or remove one item, then rebuild and rerun every check. Keep it only if tests pass, screenshots are pixel-identical, and bytes decrease; otherwise revert. Stop when no safe candidate remains, progress stalls, or approval is needed. Return measurements, changes, and untested states.

## When to use
Use this when a web app feels heavy on its first visit because it downloads too much code, styling, media, or other data before showing the initial screen.

## Success criteria
- The first screen downloads less data without a tested behavior or pixel changing.
- The same production-like measurement reports fewer downloaded bytes, existing tests pass, every representative screenshot is pixel-identical, and uncertain dependency removal remains approval-gated.

## Steps
1. Before changing code, record passing tests, representative mobile and desktop screenshots of the first screen, and a repeatable baseline for compressed transferred bytes—the amount actually downloaded.
2. Use a build or bundle report to find large or early downloads, then choose one safe candidate to delay until needed, compress, inline, or remove.
3. Rebuild and rerun the same tests, screenshots, and download measurement; keep the change only when every gate passes and bytes decrease, otherwise revert it completely.
4. Repeat until no safe candidate remains, several attempts produce no improvement, the measurement is unreliable, or the next change needs approval.

## Rationale
Recording behavior and screenshots before the first change prevents a broken screen from becoming the new normal. One download change per round also makes it clear which edit saved bytes and makes a failed attempt easy to undo.

## Implementation notes
Measure compressed transferred bytes—the amount sent over the network—not the larger source files developers read. Screenshots protect only the states they capture, so include logged-out, logged-in, empty, error, or other relevant first screens before trusting a risky change.
