# Roadmap

Working list for the beta. The receipt has to be stable enough that two defenses of the same grasp land in the same band, and cheap enough to stay under $3.

## Now

- Interview reliability: schema-checked model output, one repair turn, a deadline on every model call, idempotent answer saves, and a phase machine on the Defend page so a dropped response can be retried.
- Scoring: a per-document claim map, a fixed blueprint of question types and difficulties, questions that cite a source span and pass a grounded / unambiguous / answerable check, anchored 0–4 levels, median across the council, one follow-up when graders disagree by two levels, then a flagged receipt (not held for a person). Code forces a 0 only for a blank, a refusal, or a restatement of the question. Difficulty-weighted receipt score. Rubric `defend-it-rubric-v0.4`. Voice follow-up in beta is typed.
- Calibration script (`npm run calibrate`) reports overall stability and per-dimension min/max/stdev. `npm run soak` runs Learn and Defend on three fixtures. "I don't know" scores 0.

## Next

- Run the calibration script against the live council (Liquid / open-weight) and tighten anchors where the good/bad gap is thin.
- Voice: the follow-up after a disagreement is typed in beta, including for a voice defense. Fold that question into the LiveKit agent when the agent build is in the loop.
- A review queue for flagged receipts is not part of beta. The receipt is issued and the flag is on it.

## Later

- Open-weight voice (see `docs/model_strategy.md`) once text scoring is stable.
- Assurance levels above L1. Do not add a second holistic score; extend the same levels.
