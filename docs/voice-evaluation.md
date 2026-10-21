# Interviewer voice

Evaluated 21 Oct 2026 for a warmer, more conversational interviewer. The spoken voice is the LiveKit agent in `agent/`. Speech-to-text stays on Deepgram Nova-3. Question wording is unchanged.

**Recommendation.** Turn on xAI Grok TTS, voice Ara (“Warm, friendly”), with `TTS_PROVIDER=xai`. Leave the default at Deepgram Aura-2 Thalia. Ten minutes of Ara through LiveKit Inference is about **$0.09**, inside the $3-per-defense budget. Ara is the voice to try first: on the live Vapi Humanness Index it sits with the most human models, LiveKit already serves it from this Node agent, and the switch is an environment flag.

ElevenLabs v4 Turbo is the more expressive alternative to A/B if Ara still sounds flat. It is faster in an independent latency benchmark and sold as emotive, and it costs more and needs a new plugin plus an ElevenLabs key. It is not wired up in this change.

## What “Muse Wonder” is

Muse Wonder is Meta’s frontier reasoning model, `muse-wonder-1.0`, released 12 Oct 2026. It takes text, image, video, audio, and PDF input and **returns text**. It is built for coding and long-running agents. It does not synthesize speech. ([Meta model docs](https://dev.meta.ai/docs/models), [TechCrunch, 12 Oct 2026](https://techcrunch.com/2026/10/12/meta-releases-its-first-frontier-model-muse-wonder/), [OpenRouter](https://openrouter.ai/meta/muse-wonder))

The speech model in the same family is Muse Voice Transcribe, `muse-voice-transcribe-1.0`. Meta’s docs say it returns a transcript and does not synthesize speech or offer a speech-to-speech API. ([same model page](https://dev.meta.ai/docs/models))

A separate PyPI package, `muse-tts`, is a local Kokoro / IndexTTS wrapper. It is not Muse Wonder. ([PyPI](https://pypi.org/project/muse-tts/))

Muse Wonder is the wrong tool for the interviewer voice. This change does not call it. Using it to rewrite what the interviewer says would be a text-model change, which is outside this TTS pass.

## What speaks today

`agent/src/agent.ts` asks the questions the server already wrote. With `DEEPGRAM_API_KEY` set, TTS is the Deepgram plugin, model `aura-2-thalia-en`, `mipOptOut: true`. Without that key, TTS is the LiveKit Inference descriptor `deepgram/aura-2`.

Deepgram lists Thalia as a feminine American adult voice: “Clear, Confident, Energetic, Enthusiastic,” for casual chat, customer service, and IVR. ([Aura-2 voices](https://developers.deepgram.com/docs/tts-models)) That is a bright customer-service voice. The request is a warmer examiner.

## Comparison

Cost is for **10 minutes of interviewer speech**, the figure in the issue. The creator’s own talking time is speech-to-text, which this change does not touch.

Character-billed prices use **1,000 characters ≈ 1 minute**. That is the ratio ElevenLabs prints on its API pricing page (`$0.04` per 1,000 characters shown as about `$0.04` per minute). LiveKit Inference bills per audio minute, so that column does not use the character ratio.

| | Deepgram Aura-2 Thalia (default) | xAI Grok TTS, voice Ara (this change) | ElevenLabs v4 Turbo (expressive alternative) |
| --- | --- | --- | --- |
| Direct API, 10 min | $0.30. Pay As You Go is $0.030 per 1,000 characters. Growth is $0.027. ([Deepgram pricing](https://deepgram.com/pricing)) | $0.15. $15.00 per 1 million characters. ([xAI pricing](https://docs.x.ai/developers/pricing), checked 21 Oct 2026, page last updated 10 Oct 2026) | $0.40. $0.04 per 1,000 characters. Full v4 is $0.08 per 1,000 characters ($0.80 for the same 10 minutes). ([ElevenLabs API pricing](https://elevenlabs.io/pricing/api)) |
| LiveKit Inference, Build/Ship, 10 min | $0.18 ($0.018/min). Scale is $0.0162/min ($0.16). ([LiveKit pricing](https://livekit.com/pricing)) | $0.09 ($0.009/min on Build/Ship and on Scale). ([LiveKit pricing](https://livekit.com/pricing)) | Not offered. LiveKit Inference retired ElevenLabs on 31 Aug 2026. ([ElevenLabs plugin guide](https://docs.livekit.io/agents/models/tts/elevenlabs/)) |
| Time to first audio | Coval, Aura-2 Thalia, mean 298 ms over the last 30 days (last measured 20 Oct 2026). Of that, mean network round trip is 109 ms and mean leading silence is 189 ms. Deepgram’s product page says sub-200 ms. ([Coval Aura-2](https://benchmarks.coval.ai/models/aura-2-thalia-en), [Deepgram TTS](https://deepgram.com/text-to-speech-api-li)) | Coval mean 354 ms (last measured 21 Oct 2026), p50 341 ms, mean leading silence 54 ms. Vapi’s June 2026 streaming trial: median 285 ms with latency optimization on, 460 ms with it off. xAI publishes three `optimize_streaming_latency` levels and no millisecond claim. ([Coval Grok TTS](https://benchmarks.coval.ai/models/grok-tts), [Vapi Grok TTS](https://humannessindex.vapi.ai/models/grok-tts), [Vapi streaming](https://humannessindex.vapi.ai/models/grok-tts-streaming), [xAI TTS docs](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech)) | ElevenLabs prices v4 Turbo at about 100 ms. Coval’s 30-day board on 21 Oct 2026 measured mean 196 ms, word error rate 1.7%. ([ElevenLabs pricing](https://elevenlabs.io/pricing/api), [Coval time-to-first-audio](https://benchmarks.coval.ai/benchmarks/time-to-first-audio)) |
| Naturalness | Thalia is described as clear, confident, energetic, enthusiastic. Coval word error rate 1.9%. Thalia is not on the Vapi Humanness Index. | Live index on 21 Oct 2026: Grok TTS humanness 93, rank 3 of the listed models (1,108 blind votes). Streaming entry is 88 at 285 ms. xAI’s own page still shows a 10 Jul 2026 snapshot in which Grok led that index; the live board has since moved. Voice Ara is labeled “Warm, friendly.” Speech tags (`[pause]`, `[laugh]`, whisper, slow) exist. This change does not insert them. ([Vapi index](https://humannessindex.vapi.ai/), [xAI TTS page](https://x.ai/voice/text-to-speech), [LiveKit xAI voices](https://docs.livekit.io/agents/models/tts/xai/)) | v4 Turbo is sold as “v4 expressiveness, tuned for latency,” and v4 as “our fastest and most emotive.” On the same Vapi board, Eleven v3 scores 98 and Eleven Turbo v2 scores 77. v3’s measured latency there is 758 ms, which is a poor fit for a live question. v4 Turbo itself is not a separate row on that board. |
| LiveKit Node integration | Shipped. Plugin when `DEEPGRAM_API_KEY` is set, otherwise the descriptor `deepgram/aura-2`. | Done behind `TTS_PROVIDER=xai`. Node uses the Inference descriptor `xai/tts-1:ara`. LiveKit documents that descriptor for Node. The direct plugin is Python-only, so `XAI_API_KEY` is unused. EU endpoint is listed. ([LiveKit xAI TTS](https://docs.livekit.io/agents/models/tts/xai/)) | A Node plugin exists (`@livekit/agents-plugin-elevenlabs`, env `ELEVEN_API_KEY`). It is a new dependency and a new account. Default plugin model in the docs is `eleven_turbo_v2_5`, so v4 Turbo would be selected by model id. |

All three stay far under $3 for the speech itself. At the recommended Inference rate, TTS is about $0.09 of that budget. Grading is tracked separately against `SESSION_BUDGET_USD` (default $3) and is not part of these TTS figures.

Thalia’s Coval trace spends most of its time-to-first-audio in leading silence (189 ms of 298 ms). Grok’s leading silence is about 54 ms. Grok’s total time-to-first-audio is a bit higher because the network leg is slower, and the voice starts speaking sooner after the audio arrives. v4 Turbo wins the total-time race at 196 ms mean.

### Also looked at

Inworld Realtime TTS 1.5 Max is on LiveKit Inference at $0.021 per minute ($0.21 for 10 minutes) on Build/Ship. LiveKit describes Ashley as “Warm, natural.” Vapi scores TTS-1.5-max at humanness 80 and 337 ms. Inworld’s billing page lists on-demand TTS-1.5 Max at $10 per million characters. ([LiveKit pricing](https://livekit.com/pricing), [Vapi Inworld](https://humannessindex.vapi.ai/models/inworld-tts-1-5-max), [Inworld billing](https://docs.inworld.ai/docs/router/resources/billing))

Cartesia Sonic is on Inference at $0.030 per minute. Coval measured Sonic 3.6 at mean 294 ms. Cartesia’s own credit price is about 1 credit per character; the Pro plan ($5 for 100,000 credits) works out near $50 per million characters. ([LiveKit pricing](https://livekit.com/pricing), [Cartesia pricing](https://docs.cartesia.ai/pricing), [cartesia.ai/pricing](https://www.cartesia.ai/pricing))

Neither beat Grok on the humanness board, and both cost more than Grok on Inference.

## Why Ara, and why the flag defaults off

Ara matches the request: LiveKit’s voice list calls it warm and friendly, and the Grok model is one of the highest blind humanness scores among voices we can turn on without a new dependency. Luna (“Gentle, patient”) and Carina (“Soft, empathetic”) are the calmer alternates, via `TTS_VOICE`. The product note on viva voice is to keep the examiner calm. ([LiveKit xAI voices](https://docs.livekit.io/agents/models/tts/xai/))

The flag stays off so production keeps Thalia until someone sets `TTS_PROVIDER=xai` on the LiveKit agent. `deploy.sh` writes `TTS_PROVIDER` and `TTS_VOICE` only when those variables are already exported. A normal deploy does not set them.

`TTS_PROVIDER=xai` still uses Deepgram for speech-to-text. With a Deepgram key, that request keeps `mipOptOut`. xAI speech goes through LiveKit Inference. LiveKit’s pricing page lists zero data retention for Inference: prompts, audio, and model outputs are not logged or stored by LiveKit or the underlying providers. ([LiveKit pricing](https://livekit.com/pricing)) The questions already leave our server for whoever synthesizes them. This flag changes that provider. It does not send the document to a language model. The agent remains scripted.

## How to turn it on

On the LiveKit agent process:

```bash
TTS_PROVIDER=xai          # deepgram (default) | xai | grok
TTS_VOICE=ara             # optional; default ara. See the list in agent/src/tts.ts
```

No `XAI_API_KEY`. Billing is LiveKit Inference on the existing LiveKit Cloud project. The agent must be able to reach Inference, which is the same path the default voice uses when `DEEPGRAM_API_KEY` is unset.

An unknown `TTS_PROVIDER` or `TTS_VOICE` throws at session start.

## Samples

This environment had no `XAI_API_KEY`, `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, or LiveKit credentials, so no audio was generated. A short Ara clip needs an xAI key (the agent itself does not):

```bash
curl -sS -X POST https://api.x.ai/v1/tts \
  -H "Authorization: Bearer $XAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Hi, I am your examiner. I will ask you a few questions about your document. Take your time.","voice_id":"ara","language":"en"}' \
  --output ara-intro.mp3
```

That request shape is the xAI TTS API: `POST /v1/tts`, `voice_id`, `language`. ([xAI TTS docs](https://docs.x.ai/developers/model-capabilities/audio/text-to-speech))

To hear the current voice the same way, `DEEPGRAM_API_KEY` and `model=aura-2-thalia-en` on Deepgram’s speak endpoint. To hear v4 Turbo, an ElevenLabs API key. Neither key is required for the default agent or for `TTS_PROVIDER=xai`.
