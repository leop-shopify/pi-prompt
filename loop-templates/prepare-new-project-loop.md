---
description: "New Project Preparation Loop"
category: "Engineering"
author: "Brad Shannon (@bradshannon)"
library_number: "043"
published: "2026-06-20"
modified: "2026-06-20"
---

# New Project Preparation Loop

## Prompt
Prepare {{project}} for implementation. Ensure its documents cover requirements, technical design, tasks with acceptance criteria, and test strategy. Each round, fix the largest gap or contradiction that could make two competent engineers build different systems. Keep details traceable, record assumptions, and ask before product forks. Recheck consistency, then have two independent reviewers describe the components, data model, dependencies, and definition of done. Stop when they materially agree and every artifact is testable, or a decision needs the user.

## When to use
Use this before building a new software project when its idea or early documents still leave important implementation decisions open to interpretation.

## Success criteria
- Two independent reviewers derive substantially the same build from the project documents.
- Their descriptions agree on the components, data model, dependencies, and definition of done, and every required artifact is specific, consistent, traceable, and testable.

## Steps
1. Inventory the current project documents and identify the missing requirements, technical design, task breakdown, acceptance criteria, or test strategy needed before implementation.
2. Find the single largest gap, contradiction, or vague requirement that could make competent engineers build different systems, then close it with concrete detail traceable to a stated requirement.
3. Record assumptions that can be made safely, ask the user about genuine product forks, and recheck every edited document against the others for consistency.
4. Have two independent reviewers describe the intended components, data model, dependencies, and definition of done; repeat until their descriptions materially agree or a required decision blocks progress.

## Rationale
A concrete convergence test exposes ambiguity that a single author may read past. Fixing one divergence at a time keeps the documents coherent and turns project preparation into evidence that another engineer can follow rather than a pile of planning text.

## Implementation notes
Do not add detail merely to make the documents longer or invent product requirements to force agreement. Keep every claim tied to a stated requirement, record assumptions, and return unresolved product choices to the user.
