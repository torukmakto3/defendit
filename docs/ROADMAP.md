# Roadmap

Working list for the beta. The receipt has to be stable enough that two defenses of the same grasp land in the same band, and cheap enough to stay under $3.

## Now

- Interview reliability: schema-checked model output, one repair turn, a deadline on every model call, idempotent answer saves, and a phase machine on the Defend page so a dropped response can be retried.
- Scoring: a per-document claim map, a fixed blueprint of question types and difficulties, anchored 0–4 levels, median across the council, one follow-up when graders disagree by two levels, difficulty-weighted receipt score. Rubric `defend-it-rubric-v0.3`.
- Calibration script (`npm run calibrate`) and a service-level soak (`npm run soak`) on three fixtures.

## Next

- Run the calibration script against the live council (Liquid / open-weight) and tighten anchors where the good/bad gap is thin.
- Voice: the follow-up after a disagreement is typed today, including for a voice defense. Fold that question into the LiveKit agent when the agent build is in the loop.
- Human review queue for defenses that stay disputed after the follow-up (the receipt is still issued, and flagged).

## Later

- Open-weight voice (see `docs/model_strategy.md`) once text scoring is stable.
- Assurance levels above L1. Do not add a second holistic score; extend the same levels.
