---
description: "Boeing 747 Benchmark"
category: "Design"
author: "@victormustar"
library_number: "021"
published: "2026-06-18"
modified: "2026-06-19"
---

# Boeing 747 Benchmark

## Prompt
Before building, choose reference images, a scoring rubric, {{visual threshold}}, and {{budget}}. Build the most realistic Boeing 747 you can from Three.js primitives, then create a rig that screenshots nine repeatable angles. After each change, render and score the same views, have a critic identify the weakest feature, and fix it without regressing stronger views. Keep the best version. Stop at the threshold, stalled progress, or budget. Finish with the model, nine renders, scores, remaining gaps, and run summary.

## When to use
Use this as a concrete Three.js vision benchmark, or adapt the same capture-and-critic pattern to another rendered subject.

## Success criteria
- The Boeing 747 meets the visual bar from all nine angles.
- The same camera rig and rubric show every required view meeting the preset threshold, or the run reports stagnation, budget exhaustion, and remaining gaps.

## Steps
1. Choose reference images, a scoring rubric, a visual threshold, and a budget; then build the first Boeing 747 from Three.js primitives.
2. Create a repeatable rig that renders the same nine angles after every meaningful change.
3. Score each view against the references, have a critic identify the weakest feature, and fix it without losing stronger work.
4. Keep the best version and repeat until all nine views clear the visual bar or another named stop is reached.

## Rationale
The nine-angle rig turns a subjective 3D build into a repeatable visual test. Critiquing the same views after each change exposes problems that one hero render can hide.

## Implementation notes
The source run used a Boeing 747, Three.js primitives, nine camera angles, and repeated critics. To adapt it, replace the subject and renderer but keep fixed views, a visible quality bar, and preserved comparison renders.
