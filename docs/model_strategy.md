# Model strategy for beta (cost + voice + fast decisions)

*Working notes, Oct 2026. Guidance for the first paid/pilot beta — not locked.*

## Goal

Keep per-defense cost well under the original ~$1.5–3 estimate (voice + frontier council), while keeping the receipt credible. Prefer **open-weight models** served cheaply (or free locally), and reserve expensive proprietary voice for later assurance tiers.

## Recommended beta stack

| Job | Default (cheap) | Why | Fallback |
|---|---|---|---|
| Claim extraction, Learn coach, Defend follow-ups | **Llama 3.3 / Qwen2.5 / Mixtral** via **Groq**, **OpenRouter**, or local **Ollama/vLLM** | Open weights, JSON-capable, low $ | OpenAI mini / Anthropic Haiku |
| Grading council (2–3 families) | e.g. Llama + Qwen + Gemma (different hosts if possible) | Diversity without three frontier bills | One live + two mock compare |
| Fast structured / numerical decisions | **Jev** (TypeSafe) *or* open distill **autotrust/JEV** | Typed scores/choices in ~70–500ms; great for planted-error hit, band rollups, claim stakes, routing | Small OSS classifier / rubric heuristics in code |
| Voice (beta) | Cascaded OSS: **Whisper/Parakeet STT → OSS LLM → Kokoro/Orpheus TTS** | Runs offline or on a $GPU box; no ElevenLabs minute fee | Text interview (already shipped) |
| Voice (later / L2+) | ElevenLabs Agents or OpenAI Realtime | Proven viva UX (NYU Viva) | — |

Env wiring already supports this direction: `OLLAMA_BASE_URL`, `OPENAI_COMPAT_BASE_URL`, `GROQ_API_KEY`, plus existing OpenAI/Anthropic keys. Mock mode remains the zero-cost default.

## Open-source voice (what we found)

A full speech-to-speech viva does **not** require a proprietary realtime API. Practical options:

1. **Cascaded (best for beta):** Silero VAD → Faster-Whisper / Parakeet → local LLM → **Kokoro-82M** (Apache-2.0, CPU-friendly) or **Orpheus** (higher quality, GPU). Frameworks: Hugging Face `speech-to-speech`, Speaches (“Ollama for speech”), Unmute.sh (Kyutai).
2. **Audio-native LLM:** Ultravox / Qwen2-Audio-class models — stronger understanding of speech, still need TTS out.
3. **Plug into our adapter:** keep `src/lib/voice` as the seam; text stays default until an OSS voice pod is stable.

Honest residual: OSS voice quality and turn-taking lag commercial Realtime stacks. For beta calibration and creator prep, **text + optional OSS voice** is enough. Sell L2 voice assurance later.

## Jev and “fast decision” models

You meant **Jev** (TypeSafe “System One”): unstructured state in → **typed probabilistic decisions** out (yes/no, choice, 0–5 score), not prose. ~$0.042 / MTok input, output free; latency tens–hundreds of ms. **Not open-weight** from TypeSafe; there is an independent Apache-2.0 student on HF (`autotrust/JEV` on Qwen3.5-9B).

**Where Jev helps Defend It (without replacing the viva):**
- Score claim *stakes* and pick high-stakes spans (alongside code RNG)
- Fast rubric dimension scores / Weak–Partial–Strong bands during council chair synthesis
- Planted-error caught? confidence calibration bins
- Route “flag for human review” vs auto-issue receipt

**Where not to use it:** generating interview questions or coaching dialogue (needs generative models). Keep arithmetic and hash/signature in code — Jev’s own docs warn against trusting it for precise numbers.

**Beta call:** generative turns go through Liquid Inference (`LIQUID_API_KEY`, pinned model ids, `x-liquid-retention: none`). Jev decisions use Liquid `POST /v1/systemone` only when a decision deployment is on the book; until then the in-code heuristic stands. Do not self-host the 18–54 GB AutoTrust student for beta. Groq remains the speech path.

## Cost sketch (hypothesis)

| Path | ~$ / defense |
|---|---|
| Mock / local Ollama | ~$0 (+ electricity) |
| Groq/OpenRouter open weights, text viva | cents |
| + Jev for routing/scoring | + fractions of a cent |
| + OSS cascaded voice on a small GPU | infra, not per-API |
| Frontier council + ElevenLabs 8 min | ~$1.5–3 (original plan) |

## Product implication

Creator-driven drag-and-drop + Learn/Defend does not need a multi-provider voice stack on day one. Ship **open-weight text** for beta cost control; add OSS voice behind the existing provider interface; treat Jev as a **fast sidecar for structured judgments**, not the interviewer.
