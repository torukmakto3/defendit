# Handoff

Agents append one line here when they finish or stop. Add new lines at the top of the log. Leave older lines unchanged.

```
YYYY-MM-DD DONE — what landed · branch or PR · test evidence
YYYY-MM-DD BLOCKED — what stopped the work · what the next agent needs
```

## Log

2026-10-22 DONE — Rebased the first-party funnel onto 2d14afd (#52). Stats rate limit uses hashedClientIp, per-client beacon caps run before the global cap, challenge steps call trackChallenge, and a demo defense is not written into the admin event funnel. Unset STATS_TOKEN stays 404. · PR #46 · tsc, eslint, vitest (349)
2026-10-22 DONE — All-non-answer receipt model id is non-answer with provider rule, so modelVersions reads rule:non-answer. · PR #53 · vitest non-answer
2026-10-22 DONE — Retriggered CI for #53 after the rebase force-push did not start the Check and Browser jobs. · PR #53 · same tree as the review commit, plus this note
2026-10-22 DONE — Review of #53: rebased onto e9ae6db, keeping the shareable receipt cards and the calibration follow-up. Rubric prompt is defend-it-rubric-v0.5. GRADER_TIMEOUT_MS clamps near 59s. A budget-fallback grader stops 10s before the route deadline. An all-non-answer receipt is labeled rule:non-answer. · PR #53 · tsc, eslint, vitest (318), playwright e2e (12)
2026-10-22 DONE — Live calibration follow-up (#19): 55s grader timeout inside the 120s defend route, one retry on 503 overloaded and 404 model_not_found under the per-defense cost cap, zero grades with no council call when every answer is a non-answer, authored strong answers and an on-topic vague weak set, calibrate refuses a live router council and prints per-model scores, 2-level disagreements, latency, and cost. Rubric scores accuracy on content and requires the number to match the reason. Report in docs/calibration/2026-10-22-live.md. · PR #53 · tsc, eslint, vitest (298), mock calibrate, mock smoke, playwright e2e (12)
2026-10-22 DONE — Paste and focus-loss totals persist on the defend session, resume from defend state with the server start time, and are what the receipt signs. `GET /api/sessions/defend/state` sends `Cache-Control: no-store`. · PR #52 · tsc, eslint, vitest (313), e2e (13, including paste then reload)
2026-10-22 DONE — noteChallengeDefended consumes the challenger's credit and marks the challenge defended in one conditional transaction, so an expiry at the deadline cannot refund a credit that was already used. · cursor/atomic-challenge-defend-5695 · tsc, eslint, vitest (286)
2026-10-20 DONE — Google sign-in (authorization code, PKCE, state, verified ID token) reuses the user and session cookie. Vercel production never shows the on-screen magic link. · PR #24 · `tsc`, `eslint`, `vitest` (155), browser pass of the sign-in card (local link, Google hidden when unset, production message, Google-only card, OAuth redirect)
2026-10-20 DONE — Token and USD cost are stored for each model call. A defend session rolls up every call on that defense and is flagged over `SESSION_BUDGET_USD` (default $3). Admin list and session page show the total. Liquid uses `exchange.charge.total_usd` when present. · PR #23 · `tsc`, `eslint`, `vitest` (142), mock `npm run smoke`, admin UI in the browser
2026-10-20 DONE — A deployment refuses to grade when a council member is a router (`*.auto`) or there are fewer than 2 pinned models. Each stored grade records model id, temperature, and seed. Council list is `LIQUID_COUNCIL_MODELS`. · PR #15 · `tsc`, `eslint`, `vitest` (131)
2026-10-20 DONE — Rebased the agent brief onto main after #2, #3, #13, and #14. Roadmap now lists shipped work, next work (#7, #8, Resend, live Liquid calibration), and the on-screen magic link in production. Handoff log from #13 kept. · PR #4 · `tsc`, `eslint`, `vitest` (122), mock `npm run smoke`
2026-10-20 DONE — Non-answers are forced to 0 only when blank, a refusal ("I don't know"), or a restatement of the question. A grader that skips a question is retried once, then dropped. A retried completion keeps the flagged state. Grader prompts carry no timing. A grading claim older than 120s is released, and the repair turn stays inside that budget. `npm run calibrate` prints min/max/stdev per rubric dimension. · PR #13 · `tsc`, `eslint`, `vitest`
2026-10-20 BLOCKED — Live-council calibration needs provider keys (`CALIBRATE_LIVE=1`). Voice audio was not driven (no microphone, no agent worker).
2026-10-19 DONE — Rubric v0.4, blueprint questions that cite a source span, median graders, one follow-up then a flagged receipt. Mock calibration: known-good 74 / 75 / 80, "I don't know" 0. · PR #13 · `npm test`, `npm run calibrate`
