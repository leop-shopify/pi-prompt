---
description: "Axelrod Subagent Arena Loop"
category: "Evaluation"
author: "Kan Yuenyong (@sikkha)"
library_number: "042"
published: "2026-06-20"
modified: "2026-06-20"
---

# Axelrod Subagent Arena Loop

## Prompt
Run a fixed Axelrod tournament with two reasoning AI agents. Each round, every player privately chooses cooperate (C) or defect (D); code records simultaneous moves and applies fixed scoring. Include always-defect and always-cooperate comparison players. Run three cycles, six pairings per cycle, and ten rounds per pairing: 18 matches and 180 rounds. Hide opponent type and private reasoning. Validate every move and total. Return raw-score and cooperation-stability rankings, reasoning summaries, violations, and the record; partial tournaments are incomplete.

## When to use
Use this as a controlled experiment to see whether AI agents learn repeated-interaction behaviors such as cooperation, retaliation after betrayal, forgiveness, exploitation, and different strategies for different opponents.

## Success criteria
- All 18 matches and 180 rounds can be reproduced from the recorded moves and fixed scoring rules.
- Each agent chooses before seeing the opponent's move, every move is recorded before scoring, totals reproduce from the full history, invalid responses are logged, and any partial or invalid tournament remains explicitly incomplete.

## Steps
1. Set up fixed scoring, move validation, the match schedule, stored history for each pair, two reasoning AI players, one player that always cooperates, and one that always defects; code may score moves but never choose for the reasoning agents.
2. Before each of three tournament cycles, have each reasoning agent choose a bounded strategy using only what happened in its own earlier matches with each opponent.
3. Run all six possible pairings for ten rounds, collecting cooperate or defect choices simultaneously while hiding opponent identity and private reasoning; record every move, score, and allowed explanation.
4. Recalculate all 18 matches and 180 rounds from the saved record, then report both total points and cooperation-stability measures, strategy changes, reasoning summaries, rule violations, and any incomplete data.

## Rationale
The always-cooperate and always-defect players provide simple comparison points: they reveal whether the reasoning agents exploit easy opponents, defend themselves, rebuild cooperation, or change strategy. Hidden identities, simultaneous choices, saved pair histories, and recalculated scores keep the experiment fair and auditable.

## Implementation notes
The scoring rule is: both cooperate, 3 points each; one defects, the defector gets 5 and the cooperator gets 0; both defect, 1 point each. Total-points ranking rewards points earned, while cooperation-stability measures reward reciprocal cooperation, effective retaliation, forgiveness, and resistance to exploitation.
