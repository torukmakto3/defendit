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

SQLite DB: `./data/defend-it.db`  
Uploads: `./uploads/`  
Signing key (auto-generated): `./data/signing-key.json`  
Public key: `/.well-known/defend-it-pubkey.json`

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
3. Deploy (Vercel + Postgres) and magic-link auth  
4. Transparency log / W3C VC issuance  
5. Calibration gold-set tooling (Krippendorff α)  

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Local app |
| `npm run build` / `npm start` | Production |
| `npm test` | Unit tests |
| `npm run smoke` | Mock-mode API smoke through receipt + verify |
