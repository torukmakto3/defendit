# Defend It — agent brief

Shared brief for coding agents on this repo: Cursor, Claude Code, and Grok Bot. Product intent lives in `docs/`. Current work lives in `docs/ROADMAP.md`. When you finish or stop, append a line to `docs/HANDOFF.md`.

## What this is

Defend It lets a creator prove they understand an AI-assisted deliverable. They drop in a file, optionally use a private Socratic **Learn** coach, then take a **Defend** interview. The receiver gets an Ed25519-signed Understanding Receipt bound to the SHA-256 of those exact bytes.

`main` is the beta: secure foundation, the titleblock UI, interview scoring on rubric `defend-it-rubric-v0.4`, and CI. Mock models are the default, so the full flow runs with no API keys. The product is creator-first: drag-and-drop, then stamp and send. Receiver “Request a defense” links stay for teams that want to require a defense. Sign-in is an email magic link.

These are guidance, not a line-by-line spec:

- `docs/defend_it_thesis.md`
- `docs/defend_it_mvp_plan.md`
- `docs/product_direction.md`
- `docs/model_strategy.md`

## Stack on main

- Next.js 16 (App Router), React 19, TypeScript (`strict`), Tailwind CSS 3. Node 22 (`.nvmrc`).
- Data access is raw SQL in `src/lib/db.ts` (`?` placeholders). SQLite via `better-sqlite3` when `DATABASE_URL` is unset (`./data/defend-it-v2.db`). Postgres via the `postgres` package (postgres.js) when `DATABASE_URL` is set. `drizzle-orm` is installed and unused.
- Vitest and ESLint (`eslint .` with `next/core-web-vitals` and `next/typescript`). `npm run typecheck` is `tsc --noEmit`.
- Signing and hashing with `@noble/ed25519` and `@noble/hashes`
- Parsing with `pdf-parse`, `mammoth`, and `xlsx` (PDF, DOCX, XLSX, TXT, MD)
- One model module, `src/lib/llm`: mock, Groq, Ollama, OpenRouter, any OpenAI-compatible endpoint, OpenAI, Anthropic, and Liquid Inference. Optional Jev sidecar for typed decisions (stakes, routing). Interview prose stays on the generative models.
- Voice: text is the default in `src/lib/voice`. ElevenLabs, OpenAI Realtime, and the OSS cascade are stubs. Hard and Expert can run a live interview through the LiveKit agent in `agent/`. A grader-disagreement follow-up is typed.

## Run, test, lint

```bash
npm install
cp .env.example .env   # optional; mock mode is already the default
npm run dev            # http://localhost:3000
npm test               # Vitest
npm run smoke          # mock-mode flow through receipt and verify
npm run lint           # eslint .
npm run typecheck      # tsc --noEmit
npm run calibrate      # mock grading stability (CALIBRATE_LIVE=1 for a live council)
npm run soak           # Learn and Defend on the calibration fixtures
npm run build && npm start
```

GitHub Actions (`.github/workflows/ci.yml`) runs `npm ci`, typecheck, lint, test, and mock-mode smoke on Node 22 for every pull request.

Local runtime files: `./data/defend-it-v2.db`, `./uploads/`, and the auto-generated `./data/signing-key.json`. The public key is served at `/.well-known/defend-it-pubkey.json`. The click-through happy path is in `README.md`.

Keep secrets in `.env` or `.env.local`. Leave `data/signing-key.json`, `.env`, and the contents of `data/` and `uploads/` untracked (the empty dirs are kept with `.gitkeep`).

## Layout

```
src/app/                 pages and route handlers
  page.tsx               creator drag-and-drop
  auth/                  magic-link verify
  request/               receiver creates a defense link
  d/[token]/             learn and defend
  learn/                 projects hub and flashcard review
  r/[id]/                receipt
  verify/[id]/           in-browser hash check
  dashboard/  admin/     your items, human grading
  api/                   HTTP API, including voice agent routes
  .well-known/           published signing key
src/components/          theme, companion, receipt charts, voice interview
src/lib/                 domain logic
  llm/  voice/           model calls and the text modality
  db.ts auth.ts grading.ts rubric.ts questions.ts receipt.ts services.ts
agent/                   LiveKit interviewer
tests/                   Vitest
scripts/                 smoke, calibrate, soak
fixtures/                sample memo and calibration set
docs/                    thesis, plan, roadmap, handoff
DESIGN.md                titleblock tokens
data/  uploads/          local runtime (contents gitignored)
```

`@/*` maps to `./src/*`.

## Conventions

- Put domain logic in `src/lib`. Keep pages and route handlers thin, and validate request bodies with Zod.
- Send every model call through `src/lib/llm`. Send interview modality through `src/lib/voice`.
- Grade with `LIQUID_COUNCIL_MODELS`, a comma-separated list of pinned model ids. A deployment refuses to grade when any member is a router (`*.auto`, including `liquid.auto`) or the council has fewer than 2 members. The check runs when the server starts and again on the grade. Mock mode (`MOCK_LLM=1`, or local with no provider keys) still uses the offline council. Suggested pins, from `DEFAULT_LIQUID_COUNCIL_MODELS` in `src/lib/llm/openai-compat.ts`: `gpt-oss-120b,deepseek-v3.2,llama-3.3-70b-instruct`. Each stored grade records that model id, temperature `0`, and `GRADING_SEED` (default `0`).
- Sample which claims to probe, and where to plant errors, with the seeded PRNG in `src/lib/probes.ts` and `src/lib/rng.ts`.
- Report integrity signals (timing, paste, focus) in their own block. Leave them out of the understanding score.
- Keep Learn transcripts on the learn session. Only Defend produces a receipt.
- Put imports at the top of the file. In a `switch` on a union or enum, assign the `default` value to `never` (see `src/lib/probes.ts`).
- Add tests under `tests/` and import the library directly. `scripts/smoke.ts` drives the HTTP flow against a running app. CI starts that app with `MOCK_LLM=1`.
- This Next.js release differs from older App Router docs. Read `node_modules/next/dist/docs/` before using framework APIs, and keep the generated block at the bottom of this file. `next lint` is not the lint command; use `npm run lint`.

## Branches and pull requests

- Open a pull request for every change. `main` updates only when a PR merges.
- Keep each PR to one concern. When a change depends on another branch, name that base in the PR.
- Link an issue in the PR body. Open the issue first when none exists.
- Describe test evidence in the PR: the commands you ran and what passed (`npm test`, `npm run lint`, `npm run typecheck`, `npm run smoke`, and a browser pass when the UI changed), plus anything you could not run.

## Handoff

Append one line to `docs/HANDOFF.md` when you finish or when you stop. Add it at the top of the log. Leave older lines unchanged.

```
YYYY-MM-DD DONE — what landed · branch or PR · test evidence
YYYY-MM-DD BLOCKED — what stopped the work · what the next agent needs
```

## Roadmap

`docs/ROADMAP.md` lists what has shipped, what is next, and the known risks. Update it in the same PR that changes that status.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
