---
name: prompt-building
description: Expert prompt construction for Pi workflows. Use whenever the user wants to build, improve, multiply, review, assemble, or send a better prompt/instruction set instead of doing the underlying work now. Strongly trigger on prompt-build, prompt multiplier, pre-build prompt, exact prompt candidates, branch/probe candidates, agent instructions, or “make this prompt better.” Enforces literal user choice: generated candidates must separate exactText from rationale/evidence, and final prompts may include only the original prompt plus user-selected exactText.
---

# Prompt Building

Use this skill when the task is to construct the prompt path, not execute the destination task.

Prompt-building is a product flow: it helps the user decide what instructions a future agent should receive. The most important property is control. The user must be able to see and choose the exact text that will be written into the final prompt.

## Core rules

1. **Do not solve the underlying task.** Build the prompt that would solve it later.
2. **Do not silently write generated prose.** Anything that can enter the final prompt must be shown as `exactText` and selected by the user.
3. **Separate exact text from explanation.** Reasons, evidence, tradeoffs, and warnings belong outside `exactText`.
4. **Preserve the original prompt.** The deterministic final prompt should be the user's original prompt plus selected exactText items.
5. **Prefer fewer, sharper choices.** A multiplier is a maximum, not a quota.
6. **Make choices meaningful.** Do not create cosmetic variants that differ only in phrasing.
7. **Keep boundaries explicit.** Scope, non-goals, stop conditions, verification, and reporting expectations often matter more than style.

## Topic/probe design

When multiplying prompt-build work, pre-build creates concrete prompt-building **topics**. Each topic is sent to one probe agent, and that agent must stay on the assigned topic while producing options that extend or refine that same topic.

Good topics include:

- Goal, scope, non-goals, and acceptance criteria.
- Domain role and skills the future agent should load.
- Evidence sources: files, docs, logs, tests, UI state, prior reports.
- Execution sequence and delegation model.
- Verification, reproducibility, and final reporting.
- Risk boundaries: security, production, data, install/deploy/commit restrictions.
- Product or UX tradeoffs the future prompt must not decide silently.

Do not create topics just to use the multiplier. If five topics are useful for a 25x request, use five. Every topic probe must return 3-5 valid actionable candidates for that same topic; fewer than three candidates is a failed topic, and more than five candidates will be ignored.

## Candidate JSON contract

Prompt-build agents should return only JSON in this shape:

```json
{
  "branch": {
    "index": 1,
    "title": "Short branch title",
    "summary": "What this branch contributes to the future prompt"
  },
  "candidates": [
    {
      "label": "Chooser label",
      "exactText": "Exact prompt text the user may choose to include. It must stand alone.",
      "rationale": "Why this candidate helps. This is not written into the final prompt.",
      "evidence": "Concrete files/docs/observations used, or 'No external evidence needed'."
    }
  ]
}
```

Candidate quality bar:

- Each assigned topic returns 3-5 valid actionable candidates total.
- Every candidate stays on the assigned topic.
- `exactText` is imperative and operational.
- `exactText` contains no unsupported claims.
- `rationale` explains the choice, not generic value.
- `evidence` names real sources when consulted.
- Alternatives are materially different decisions, not synonyms.

## Final prompt assembly

Final assembly must be deterministic:

```text
[original prompt]

<original user prompt>

[detailed prompt]

<selected exactText 1>

<selected exactText 2>

<selected exactText N>
```

Do not ask another model to synthesize the final prompt from branch reports. That reintroduces unchosen text. If synthesis is needed, offer it as selectable `exactText` first.

## Review UI expectations

A good prompt-build review flow lets the user:

- Navigate by branch and by next undecided candidate.
- Multi-select any number of candidates.
- Ignore individual candidates, not whole branches only.
- See exactText, rationale, evidence, and source separately.
- Preview the exact final prompt before sending.
- Send the final prompt as a Pi user message/follow-up, not as a temp file path.

## Stop conditions

Stop and ask the user instead of guessing when:

- The future prompt would authorize irreversible or production-impacting actions not explicitly requested.
- The prompt needs a product/architecture decision that is not in the user's goal.
- A candidate would include facts not verified by the probe.
- The user asked for prompt construction, but the flow is about to execute the work.
