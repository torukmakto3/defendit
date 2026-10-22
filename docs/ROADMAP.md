# Roadmap

Status of Defend It on `main` as of 22 Oct 2026. #2, #3 (including #13 and #14), are merged. #1 is closed.

## Shipped

- **Secure foundation** ([#2](https://github.com/torukmakto3/defendit/pull/2)). Email-link accounts, encryption at rest, process-and-purge, minimal receipts, zero-retention model calls. Postgres when `DATABASE_URL` is set (raw SQL through postgres.js); SQLite locally.
- **Titleblock redesign** ([#3](https://github.com/torukmakto3/defendit/pull/3)). Day and night themes, robot companion, PDF certificate and PNG stamp, Learn projects and flashcards, LiveKit voice for Hard and Expert (`agent/`). Tokens in `DESIGN.md`.
- **Interview reliability and rubric v0.4** ([#13](https://github.com/torukmakto3/defendit/pull/13)). Schema-checked model output, one repair turn, deadlines, idempotent answer saves, a fixed question blueprint, median grading, one follow-up then a flagged receipt. Rubric `defend-it-rubric-v0.4`. `npm run calibrate` and `npm run soak`.
- **CI** ([#14](https://github.com/torukmakto3/defendit/pull/14)). Every pull request runs install, typecheck, lint, tests, and mock-mode smoke on Node 22.
- **Pinned grading council** ([#15](https://github.com/torukmakto3/defendit/pull/15), [#7](https://github.com/torukmakto3/defendit/issues/7)). `LIQUID_COUNCIL_MODELS` is a comma-separated list of pinned models. A deployment refuses to start and refuses to grade when any member is `*.auto` or there are fewer than 2. Each stored grade keeps the model id, temperature, and seed.
- **Per-defense token and cost tracking** ([#8](https://github.com/torukmakto3/defendit/issues/8)). Each model call stores prompt tokens, completion tokens, and USD cost. A defend session total includes every call on that defense. The admin list and session page show the total and flag a defense over `SESSION_BUDGET_USD` (default $3).
- **Google sign-in** ([#16](https://github.com/torukmakto3/defendit/issues/16)). Authorization code with PKCE and state. The ID token is verified (issuer, audience, signature) and `email_verified` must be true. The verified email opens the same `users` / `auth_sessions` rows and `di_session` cookie as a magic link, matched case-insensitively, including `ADMIN_EMAILS`.
- **Grader settings on the receipt** ([#25](https://github.com/torukmakto3/defendit/issues/25)). The signed receipt records each grader's model, temperature, and seed. `/r/[id]` and `/verify/[id]` show them. Older receipts that only have model ids still verify and render.
- **Optional warmer interviewer voice** ([#28](https://github.com/torukmakto3/defendit/issues/28)). `TTS_PROVIDER=xai` speaks with xAI Grok TTS, voice Ara, through LiveKit Inference. Unset or `deepgram` keeps Aura-2 Thalia. Comparison and the Muse Wonder finding are in `docs/voice-evaluation.md`.
- **Interview start and grading latency** ([#27](https://github.com/torukmakto3/defendit/issues/27)). Per-stage timings on the admin session. The council runs in parallel, each member on its own timeout, and token accounting is flushed once after the graders return. The first question is phrased while the upload is saved. The interview shows how many graders have finished.
- **Learn after the file text is deleted** ([#35](https://github.com/torukmakto3/defendit/pull/35)). Dashboard Workspace for a creator opens that deliverable's Learn flashcards. The deck is cached, encrypted like other card fields, just before document text is deleted (defense completion, or the 72-hour text timer). Learn serves that deck afterwards. A finished defense with no saved deck asks the creator to upload the same file again. Raw document text is not kept any longer.
- **First flashcard while the rest load** ([#36](https://github.com/torukmakto3/defendit/issues/36)). Learn streams card 1 from the pinned `FLASHCARD_MODEL` and appends the rest as later batches finish. A stored deck renders with no model call. Caching that deck before the text wipe does not hold the receipt. Time to first card is logged as `stage: first_card`.

## Next

- **Real email sign-in via Resend** (`RESEND_API_KEY`, `EMAIL_FROM`). Blocked on a sending domain. Google covers production sign-in until then. Preview can still use on-screen links.
- **Live calibration with Liquid models.** The mock harness is in place (`npm run calibrate`). A live run is `CALIBRATE_LIVE=1` and needs provider keys. Tighten anchors where the good/bad gap is thin.

## Known risks

- **On-screen dev links.** Local dev shows the sign-in URL on the page. A preview deploy can too, with `AUTH_DEV_LINKS=1` and an allowlist. `VERCEL_ENV=production` never returns that URL, even if `AUTH_DEV_LINKS=1`. Admin addresses never get one. Anyone who can open a preview with the flag on can still use a link for an allowed address.
