# Defend It

Prove you understand an AI-assisted deliverable. Receivers get a **signed Understanding Receipt** bound to the exact file hash.

Guidance docs (not a line-by-line spec): `docs/defend_it_thesis.md`, `docs/defend_it_mvp_plan.md`.

## One command

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Mock/offline LLM mode is on by default — the full flow works with **no API keys**.

## What this prototype includes

| Flow | Status |
|---|---|
| Receiver creates a “Request a defense” link + difficulty | ✓ |
| Creator uploads PDF / DOCX / TXT / MD (hashed SHA-256) | ✓ |
| **LEARN** — private Socratic coach + gap map (never shared) | ✓ |
| **DEFEND** — text interview; probes sampled in code (not by the LLM) | ✓ |
| Answer timing recorded as an integrity signal | ✓ |
| Multi-model grading council + rubrics per difficulty | ✓ |
| Integrity shown **separately** from understanding score | ✓ |
| Ed25519-signed receipt + stamp SVG with QR | ✓ |
| Public verify page (in-browser hash check) | ✓ |
| Receiver dashboard | ✓ |
| Admin human-grading view (transcript + AI vs human) | ✓ |
| Voice provider adapter (text default; ElevenLabs / Realtime stubs) | ✓ |

## Architecture

```
src/lib/
  llm/          Single module for all model calls (mock | OpenAI | Anthropic)
  voice/        Pluggable interview modality (text today; voice stubs ready)
  crypto.ts     SHA-256 + Ed25519 sign/verify
  claims.ts     Claim extraction from deliverable text
  probes.ts     Probe bank + deterministic seed sampling
  grading.ts    Rubric + council grading
  integrity.ts  Timing / paste / focus signals (never mixed into score)
  receipt.ts    Canonical signed receipt payload
  stamp.ts      Shareable badge SVG + QR
  db.ts         SQLite (better-sqlite3) under ./data/
  services.ts   Request → upload → learn/defend → grade → receipt
```

**Randomness rule:** which claims to probe and where to plant errors is drawn with a seeded PRNG in `probes.ts`. The LLM never chooses “randomly.”

**Two modes:** LEARN transcripts stay on the learn session and are never written into receipts. Only DEFEND produces a receipt.

## Run locally

```bash
cp .env.example .env   # optional; defaults are fine
npm install
npm run dev            # http://localhost:3000
npm test               # hashing, signing, probe determinism
npm run smoke          # end-to-end API flow in mock mode
```

SQLite DB: `./data/defend-it-v2.db`  
Uploads: `./uploads/`  
Signing key (auto-generated): `./data/signing-key.json`  
Public key: `/.well-known/defend-it-pubkey.json`

### Sign in

Locally, the sign-in card shows an on-screen magic link (no email provider required). Production sign-in is Google.

1. In Google Cloud Console, configure the OAuth consent screen. While it stays in **Testing**, add the Google account as a test user.
2. Create an OAuth client ID of type **Web application**.
3. Authorized JavaScript origins: `https://defendit-two.vercel.app` and `http://localhost:3000`.
4. Authorized redirect URIs, exact:
   - `https://defendit-two.vercel.app/api/auth/google/callback`
   - `http://localhost:3000/api/auth/google/callback`
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Set `APP_URL=https://defendit-two.vercel.app` (or `NEXT_PUBLIC_APP_URL` to that same origin). The redirect URI is that origin plus `/api/auth/google/callback`. If both are unset on Vercel, the origin is `https://$VERCEL_PROJECT_PRODUCTION_URL`.
6. Set `ADMIN_EMAILS` to the verified email, for this deployment `luisnunez1940@hotmail.com`.

Admin access follows that verified email, compared case-insensitively. The Hotmail address has to be added and verified on the Google account (Google Account → Personal info → Email). Signing in with a different Gmail does not open `/admin`. The sign-in screen asks Google to show the account picker so the right account can be chosen.

The Google button is hidden when `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is missing. The email form is shown only when Resend is configured (`RESEND_API_KEY` and `EMAIL_FROM`) or an on-screen dev link is allowed. Otherwise the card says sign-in is not available, instead of failing with a 503.

On-screen links are a local and preview convenience. `VERCEL_ENV=production` never returns one, even if `AUTH_DEV_LINKS=1`. Preview can opt in with `AUTH_DEV_LINKS=1` and `AUTH_DEV_LINK_ALLOW`. Admin addresses never get an on-screen link. Magic-link email stays in place for when Resend has a sending domain.

### Try the happy path

1. **Request** → `/request` → create a Hard link  
2. Open the creator link → upload `fixtures/sample-memo.md`  
3. Optional **Learn** → answer a few coach prompts → gap map  
4. **Defend** → answer each question → receipt + stamp  
5. **Verify** → drop the same file (match) then an edited copy (doesn’t match)  
6. **Dashboard** → load `alex@fund.example`  
7. **Admin** → open the session, enter a human score, compare to the council  

## Turning on real models (prefer open-weight for beta)

Leave `MOCK_LLM` unset (or `MOCK_LLM=0`) and configure **one** cheap path:

```bash
# Recommended beta: Groq + open-weight Llama
MOCK_LLM=0
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile
GROQ_MODEL_B=llama-3.1-8b-instant   # second council member

# Or local
# LLM_PROVIDER=ollama
# OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
# OLLAMA_MODEL=llama3.2

# Or OpenRouter / generic OpenAI-compatible — see .env.example
```

Frontier keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) still work. Optional **Jev** (`JEV_API_KEY`) is a fast typed-decision sidecar for stakes/routing — not the interviewer. See `docs/model_strategy.md`.

Never commit `.env` or `data/signing-key.json`.

### Voice later

```bash
VOICE_PROVIDER=text              # default (ships today)
# VOICE_PROVIDER=elevenlabs      # stub
# VOICE_PROVIDER=openai-realtime # stub
# Planned: cascaded OSS (Whisper/Parakeet → LLM → Kokoro/Orpheus)
```

Session orchestration stays on our server; the voice provider only carries the conversation.

## Product direction (beta)

- **Creator-first:** drag-and-drop on `/`, then Learn or Defend — no install, no receiver account required.
- **Stamp & send:** after a pass you get a badge + printable cover; attach to the same file and send via email/Slack/Docs.
- **Receiver links** (`/request`) remain for pilots that want to *require* a defense.
- **Later:** embeddable widget for receiver workflows (interview portals, LMS, PR checks).

## Difficulty levels

- **Standard** — key claims and why they hold  
- **Hard** — what-ifs, stretched assumptions, planted error  
- **Expert** — adversarial edge cases and counterarguments  

## Receipt contents

Score, difficulty, date, creator name/email, SHA-256 of exact bytes, rubric + model versions, per-question evidence excerpts, integrity block, Ed25519 signature.

## What’s next

1. Realtime **voice** viva (ElevenLabs Agents or OpenAI Realtime) behind the existing adapter  
2. Google Picker / GitHub PR ingest  
3. Resend magic-link email (Google sign-in covers production accounts)  
4. Transparency log / W3C VC issuance  
5. Calibration gold-set tooling (Krippendorff α)  

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local app |
| `npm run build` / `npm start` | Production |
| `npm test` | Unit tests |
| `npm run smoke` | Mock-mode API smoke through receipt + verify |
