---
name: probe
description: Read-only investigation skill for quickly probing a repo, system, docs, logs, UI behavior, or uncertainty before deciding what prompt or implementation path to take. Use whenever the task says probe, investigate, inspect, validate assumptions, gather evidence, compare paths, or produce candidate findings without editing. Especially useful for prompt-build branch agents that must return exact prompt options with rationale and evidence.
---

# Probe

Use this skill to gather evidence without changing anything.

A probe is not a fix. It is a bounded read-only pass that answers: "what is true, what matters, and what should the future prompt or implementation account for?"

## Non-negotiables

- Stay read-only. Do not edit files, write files, install packages, start services, commit, push, deploy, or mutate external systems.
- Prefer source evidence over guesses: file paths, function names, command output, docs, logs, tests, or exact observed behavior.
- Keep the probe bounded. Stop when you have enough evidence for the requested decision or candidate prompt text.
- Report uncertainty honestly. Do not upgrade a weak signal into a fact.
- If a fix is obvious, report it as a recommendation; do not apply it.

## Probe workflow

1. Restate the question in one sentence.
2. Identify likely evidence sources before reading broadly.
3. Inspect the highest-signal files/commands first.
4. Record concrete observations with paths and snippets when useful.
5. Separate facts, interpretations, and recommendations.
6. If producing prompt-build candidates, keep exact prompt text separate from rationale/evidence.

## Output for ordinary probes

```text
Question:
<what was probed>

Findings:
- <fact with evidence path/command>
- <fact with evidence path/command>

Interpretation:
- <what the findings mean>

Recommendation:
- <what the future agent/user should do next>

Uncertainty / limits:
- <what was not verified>
```

## Output for prompt-build probes

When the probe feeds prompt-build, you receive one assigned prompt-building topic. Stay on that topic and return structured JSON so the UI can let the user choose exact text literally. Return at least three valid candidates for the assigned topic; fewer than three candidates is invalid output.

```json
{
  "branch": {
    "index": 1,
    "title": "Short path title",
    "summary": "What this probe angle contributes to the future prompt"
  },
  "modules": [
    {
      "id": "scope",
      "title": "Scope guard",
      "candidates": [
        {
          "label": "Smallest safe scope",
          "exactText": "Exact prompt text the user can choose to include.",
          "rationale": "Why this candidate helps; not written into the final prompt.",
          "evidence": "File paths, docs, logs, commands, or 'No external evidence needed'."
        }
      ]
    }
  ]
}
```

Rules for prompt-build JSON:

- `exactText` must be complete, copy-ready instruction text.
- Keep rationale and evidence out of `exactText`; the final prompt only includes chosen exactText.
- Do not fabricate evidence. If no evidence was needed, say so.
- Produce at least three high-signal candidates for the assigned topic.
- Do not solve the user's goal inside exactText; encode how the future agent should solve it.
- Do not drift into another topic. If another topic matters, mention it in rationale/evidence rather than returning off-topic exactText.
