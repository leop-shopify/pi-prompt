---
name: pre-build-prompt
description: Use before starting substantial implementation, debugging, refactoring, testing, launch, or agent-delegated work when the user's request would benefit from a sharper prompt first. Turns a raw goal into a ready-to-send work prompt by clarifying scope, constraints, evidence, risks, acceptance criteria, and sequencing. Trigger when the user asks to plan the prompt, build a prompt, prepare instructions, improve a task brief, or when the request is high-impact but under-specified.
---

# Pre-Build Prompt

Use this skill to construct the prompt that should be sent for the real work. Do not do the real work while using this skill.

The output is a better work prompt: clear enough that a future agent can execute without guessing, overreaching, or silently choosing risky defaults.

For prompt-build multiplier mode, pre-build first identifies concrete prompt-building topics. Each topic will be sent to a probe agent, and that agent must return 3-5 actionable options for extending or refining that same topic.

## Core stance

- Treat the user's request as a goal to encode, not a task to solve now.
- Preserve the user's intent and voice. Do not smuggle in features, refactors, tests, deploys, or process the user did not ask for.
- Make assumptions explicit. If the future agent must choose, encode the decision point or ask the user before the work starts.
- Prefer a prompt that makes success measurable: files/systems in scope, non-goals, constraints, verification, and report format.
- Keep prompt text operational. The future agent should know exactly what to read, change, avoid, verify, and report.

## Prompt construction checklist

Include only sections that matter for the specific goal. In multiplier mode, turn relevant sections into topics first, then let probe agents propose options per topic.

1. **Goal** — one sentence describing the outcome, not implementation guesses.
2. **Context** — relevant repo paths, system names, user corrections, prior findings, issue IDs, or constraints.
3. **Scope** — what is in scope and explicitly out of scope.
4. **Approach** — expected workflow sequence, such as inspect first, then edit, then narrow verification.
5. **Decision rules** — when to stop and ask instead of guessing.
6. **Evidence** — what local files, docs, logs, tests, or commands should anchor the work.
7. **Safety boundaries** — no commits, pushes, installs, services, deploys, data changes, or broad cleanup unless explicitly allowed.
8. **Acceptance criteria** — observable conditions that make the work complete.
9. **Verification** — exact or narrow command classes to run, or say why verification is impossible.
10. **Final report** — files changed, commands/results, risks, and follow-ups.

## Exact prompt format

When asked to draft the prompt, return a ready-to-send message. Use this structure by default:

```text
Goal:
<one clear outcome>

Context:
- <relevant facts, paths, issue IDs, prior findings>

Scope:
- In: <allowed work>
- Out: <forbidden or deferred work>

Instructions:
1. <ordered work step>
2. <ordered work step>
3. <ordered work step>

Stop and ask if:
- <ambiguity/risk condition>

Verification:
- <narrow checks or expected proof>

Report back with:
- <files changed/read>
- <verification commands and results>
- <remaining risks/follow-ups>
```

Omit empty sections rather than padding.

## What not to do

- Do not solve the underlying goal.
- Do not invent project facts. If uncertain, write the prompt so the future agent investigates.
- Do not hide important constraints in prose. Make them bullets the future agent cannot miss.
- Do not create a giant prompt when a small one is enough.
- Do not include generic best practices unless they change the future agent's behavior for this goal.
