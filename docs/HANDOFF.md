# Handoff

Agents append one line here when they finish or stop. Add new lines at the top of the log. Leave older lines unchanged.

```
YYYY-MM-DD DONE — what landed · branch or PR · test evidence
YYYY-MM-DD BLOCKED — what stopped the work · what the next agent needs
```

## Log

2026-10-20 DONE — Non-answers are forced to 0 only when blank, a refusal ("I don't know"), or a restatement of the question. A grader that skips a question is retried once, then dropped. A retried completion keeps the flagged state. Grader prompts carry no timing. A grading claim older than 120s is released, and the repair turn stays inside that budget. `npm run calibrate` prints min/max/stdev per rubric dimension. · PR #13 · `tsc`, `eslint`, `vitest`
2026-10-20 BLOCKED — Live-council calibration needs provider keys (`CALIBRATE_LIVE=1`). Voice audio was not driven (no microphone, no agent worker).
2026-10-19 DONE — Rubric v0.4, blueprint questions that cite a source span, median graders, one follow-up then a flagged receipt. Mock calibration: known-good 74 / 75 / 80, "I don't know" 0. · PR #13 · `npm test`, `npm run calibrate`
