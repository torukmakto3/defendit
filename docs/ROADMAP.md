# Roadmap

Status of Defend It on `main` as of 20 Oct 2026. #2, #3 (including #13 and #14), are merged. #1 is closed.

## Shipped

- **Secure foundation** ([#2](https://github.com/torukmakto3/defendit/pull/2)). Email-link accounts, encryption at rest, process-and-purge, minimal receipts, zero-retention model calls. Postgres when `DATABASE_URL` is set (raw SQL through postgres.js); SQLite locally.
- **Titleblock redesign** ([#3](https://github.com/torukmakto3/defendit/pull/3)). Day and night themes, robot companion, PDF certificate and PNG stamp, Learn projects and flashcards, LiveKit voice for Hard and Expert (`agent/`). Tokens in `DESIGN.md`.
- **Interview reliability and rubric v0.4** ([#13](https://github.com/torukmakto3/defendit/pull/13)). Schema-checked model output, one repair turn, deadlines, idempotent answer saves, a fixed question blueprint, median grading, one follow-up then a flagged receipt. Rubric `defend-it-rubric-v0.4`. `npm run calibrate` and `npm run soak`.
- **CI** ([#14](https://github.com/torukmakto3/defendit/pull/14)). Every pull request runs install, typecheck, lint, tests, and mock-mode smoke on Node 22.
- **Pinned grading council** ([#15](https://github.com/torukmakto3/defendit/pull/15), [#7](https://github.com/torukmakto3/defendit/issues/7)). `LIQUID_COUNCIL_MODELS` is a comma-separated list of pinned models. A deployment refuses to start and refuses to grade when any member is `*.auto` or there are fewer than 2. Each stored grade keeps the model id, temperature, and seed.
- **Per-defense token and cost tracking** ([#8](https://github.com/torukmakto3/defendit/issues/8)). Each model call stores prompt tokens, completion tokens, and USD cost. A defend session total includes every call on that defense. The admin list and session page show the total and flag a defense over `SESSION_BUDGET_USD` (default $3).

## Next

- **Real email sign-in via Resend** (`RESEND_API_KEY`, `EMAIL_FROM`). Blocked on a sending domain. Until that ships, sign-in depends on the on-screen dev link.
- **Live calibration with Liquid models.** The mock harness is in place (`npm run calibrate`). A live run is `CALIBRATE_LIVE=1` and needs provider keys. Tighten anchors where the good/bad gap is thin.

## Known risks

- **The dev magic link is shown on screen in production.** With Resend unset, `requestMagicLink` returns the sign-in URL in the response instead of emailing it. On a deploy that is allowed when `AUTH_DEV_LINKS=1`. Anyone who can see that screen can use the link. Turn the on-screen path off once Resend is sending.
