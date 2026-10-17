# Defend It: MVP Plan

*For Luis, 17 Oct 2026. Builds on `defend_it_thesis.md` and `ai_understanding_thesis.md`. Bracketed numbers refer to the sources at the end. Prices were checked on 17 Oct 2026; anything marked "estimate" or "hypothesis" is my own reasoning, not a sourced figure. Nobody has been contacted.*

---

## 0. TL;DR

- **Wedge:** a **no-install web app with a "Request a defense" link**. The *receiver* (partner, PM, client, reviewer) sends the link. The *creator* drops in the deliverable (Google Doc via Picker, PDF, DOCX, XLSX, MD, or a GitHub PR URL) and does a **6–8 minute voice viva in the browser**. The receiver gets a **signed Understanding Receipt link** tied to a hash of the exact file version. Integrations (GitHub check, Docs sidebar, Slack) come after the core loop works.
- **Why receiver-initiated:** research says people avoid friction they don't have to take on [R36 in the thesis]. Demand comes from the person who signs off. The creator's payoff is the **prep coach** (understand it faster), and the viva is short.
- **First customers:** (1) small investment and research teams (VC/PE/crypto funds, IC memos), (2) boutique and independent consulting, (3) a business school or bootcamp pilot for calibration volume. Engineering PR review is **4th**: it hurts, but it's already crowded with cheap PR-quiz tools [21–25].
- **Trust:** questions grounded in the deliverable, with randomness drawn in code; voice-first; adaptive follow-ups and counterfactual or planted-error probes; integrity signals (timing, focus, paste) reported **separately** from the understanding score, as OralExam.ai does [17]; a multi-model grading council with a human audit flag, as NYU Viva does [14].
- **Verification:** the receipt carries a SHA-256 of the exact deliverable, rubric and model versions, per-question evidence with audio timestamps, and an Ed25519 signature. It's issued as a **W3C Verifiable Credential 2.0** [26][27] and appended to a transparency log [29]. The receiver can drop the file onto the verify page to confirm it's the same version, and can replay the clips.
- **Unit cost (estimate):** about $1.5–3 per defense (voice $0.4–1.5 plus grading under $1). Viva reports grading at $0.29–0.96 per exam [14].

---

## 1. Best way to build it

### 1.1 Creator UX options

| Option | Creator friction | Receiver trust/verify | Build effort (2–3 wk) | Verdict |
|---|---|---|---|---|
| **Web app plus share link** (upload PDF/DOCX/XLSX/MD, paste a Google Doc via Picker, paste a PR URL) | Low: one link, no install, mic in the browser | Best: we control the session, the hashing and the receipt | Low | **MVP wedge** |
| Google Docs sidebar add-on | Very low once installed | Good | Medium-high. Public Marketplace apps go through app review, and `drive.readonly` is a *restricted* scope that needs a third-party security assessment [30][31]. Avoid this by using `drive.file` plus the **Google Picker** in the web app, which is non-sensitive and limited to files the user picks [32] | Phase 2 |
| Chrome extension (overlay on Docs/GitHub) | Low | Medium: runs in the creator's browser, so it's easier to tamper with | Medium. Gater already ships a GitHub App plus a Chrome extension [22] | Later |
| Slack app (`/defend`, receipt unfurl) | Low for distribution | Medium | Medium | Phase 2, as a distribution layer, not the viva itself |
| **GitHub PR app** (Check Run "Defended ✓", required status check) | Low for devs | Good: a check run carries the head SHA. Needs a GitHub App with `checks:write`, and branch protection can require the check [33] | Medium | Phase 2. The space is crowded (sphinx-ci, Gater, Aisance, MOTHER, PR Comprehension Quiz Gate [21–25]), all text quizzes |

**Recommendation.** Start with a web app plus a receiver-initiated "Request a defense" link. It works for any deliverable type, needs no install or marketplace review, and keeps the session on our own trusted surface. Add a **GitHub Check Run** as the first integration in week 3 *only if* a pilot team is engineering. Our edge there is a **voice viva plus a signed receipt** instead of yet another multiple-choice quiz.

**Friction budget for the creator (target):** about 60 seconds from opening the link to the first question, 6–8 minutes of viva, and an optional 5–10 minutes of prep coaching beforehand. No account needed for the first defense: a magic link to a work email is enough.

### 1.2 Viva format: voice or text

- **Voice by default, with a text fallback for accessibility.** Voice makes copy-paste from a second AI harder and gives timing and speech signals (§2.1). Viva found students rated "tested my actual understanding" highest (66–70%), but stress was high (83% then 63% "more stressful") and a slow-speaker fairness risk remains. They recommend configurable pacing, voice choice, an ungraded practice run and a text alternative [14]. OralExam.ai runs about 6 minutes, repeats questions word for word and doesn't penalise filler words [17].
- **Lessons from Viva to copy directly [14]:**
  1. Split into single-purpose phases (identity, deliverable defense, transfer/counterfactual, close).
  2. Enforce behaviour in code, not prompts. Use a turn validator that rejects stacked questions (stacking was the #1 complaint, 31% of turns, down to 11% once enforced in code).
  3. **Never let the LLM randomise.** It picked one case in 86% of exams when asked to choose "randomly". Draw seeds in code.
  4. Set the silence timeout to about 30 seconds, because silence is thinking time.
  5. Use a calm preset voice. A cloned professor voice came across as "mean".
- **Live transcript on screen.** Viva added it for non-native speakers [14].

### 1.3 Voice stack options: cost and latency

| Option | Published price | Notes |
|---|---|---|
| **OpenAI Realtime** `gpt-realtime-2.1` | $32 / $64 per 1M audio in/out tokens. OpenAI's own conversion is about $0.019/min of user audio and about $0.077/min of assistant speech. The `-mini` version is about $0.006 and $0.024 [1][2] | Speech-to-speech, tool calls, WebRTC. The full conversation is re-sent each turn, so later turns cost more (cached input is $0.40/1M) [2]. Viva notes that porting to Realtime means rebuilding orchestration yourself [14] |
| **ElevenLabs Agents** | $0.08/min extra call minutes (Pro is $99/mo with 1,238 min), with the LLM billed separately [3] | Used by NYU Viva. Built-in multi-agent workflows plus dynamic variables (per-session context) and transcript export [14] |
| **Vapi** | $0.05/min platform fee plus providers at cost (e.g. Deepgram STT about $0.0095/min, OpenAI LLM $0.008–0.045/min, ElevenLabs TTS $0.015–0.024/min) [5][6] | Flexible; bring your own keys |
| **Deepgram Voice Agent API** | $0.075/min Standard (includes STT, LLM orchestration and TTS); $0.050/min with your own LLM and TTS; $0.163/min Advanced (larger LLMs) [7] | Billed on socket connection time, so close sessions promptly |
| **LiveKit Agents** (open source) | Framework is free (Apache-2.0); LiveKit Cloud agent sessions about $0.01/min plus model providers [8] | Most control and a good turn detector; more engineering |

**Latency.** An independent phone-call benchmark measured median time-to-first-audio of 1,296 ms (Telnyx), 1,424 ms (ElevenLabs) and 1,558 ms (Vapi), with p95 between 1.8 and 2.3 seconds. None was under 1 second [4]. That was over phone lines. In-browser WebRTC should be somewhat faster, but I found no independent number for it, so we should measure our own. For a viva, about 1.5 seconds is fine; correctness of turn-taking matters more.

**Recommendation.** For speed, build the MVP on **ElevenLabs Agents**, the stack Viva proved works for this [14], at about $0.64 for 8 minutes plus LLM. Keep the question plan, randomisation and validators **in our server**, and pass them in as dynamic variables. Keep a thin adapter so we can switch to OpenAI Realtime (`-mini` for cost) later. *Estimate:* an 8-minute session on gpt-realtime-2.1 costs about $0.5–1.5 once re-sent context is included.

### 1.4 Question generation grounded in the deliverable

Pipeline (all server-side, deterministic where possible):

1. **Ingest and hash.** Store the exact bytes and compute SHA-256. For Google Docs, also record the file ID and revision ID, export to PDF and DOCX, and hash the export. Parse into sections or claims (memo), sheets, named ranges and key formulas (model), or diff hunks (PR).
2. **Claim and decision map.** An LLM extracts 8–15 load-bearing claims, assumptions, numbers and decisions, each with a source span.
3. **Probe bank** per claim, using the probe types from the research brief: *explain-back* ("walk me through why…"), *counterfactual* ("if churn doubles, what happens to the IRR in tab 3?"), *prediction* ("before I tell you, what does this function return for an empty list?"), *weakest-link* ("what's the most fragile assumption?"), *planted error* (show a slightly altered version of one figure or line and ask whether it's right), *confidence rating* (0–100%, scored later with a Brier score).
4. **Sample in code.** Use a per-session random seed to pick about 5 claims and probe types, weighted toward high-stakes spans [14]. The receiver can **pin** claims they care about ("must ask about the exit multiple").
5. **Adaptive follow-ups.** At most two per claim, generated live from what the creator just said ("follow up twice: why, then what if" is also the standard advice in anti-cheating guides [12]). One question per turn, enforced by a validator.

**Creator prep coach (same engine, low stakes).** The same probe bank runs as a Socratic coach in text or voice. It never gives the answer first, it shows a **gap map** of weak sections, and it offers a one-click "re-explain this to me" on any span. The prep transcript is *private by default* and is never graded or shared, following Grammarly's "user decides when to share" pattern from the thesis. This is how we deliver "understand it in depth faster".

### 1.5 Grading: rubrics, multiple models, calibration

- **Rubric (0–4 per claim, per dimension):** Accuracy, Reasoning (why, not just what), Transfer (counterfactuals and prediction), Error detection (planted error caught?), Ownership (can name sources, alternatives and what they'd change). Results show per claim, then roll up into **Weak / Partial / Strong per section**. Following OralExam.ai, the receipt shows categories plus evidence and the 0–100 number stays internal at first, since "a percentage only sounds precise" [17].
- **Council grading (Viva pattern) [14]:** 3 models from different families score independently with verbatim transcript evidence. They then deliberate, seeing anonymised peer outputs, and a chair synthesises. Viva found agreement was poor before deliberation (α 0.52–0.65) and good after (0.86–0.90), and that one model kept a stable lenient bias. Their audit rule flagged about 3% of exams.
- **Our audit rule:** flag for human review when the two strictest raters differ by more than 1 point on any claim, or when integrity signals are amber or red. During the pilot, *Luis or a pilot-team expert reviews every flagged receipt*.
- **Calibration:**
  - (a) **Gold set.** Two humans blind-grade about 30 transcripts. Target Krippendorff's α ≥ 0.80 between council and humans, the threshold Viva uses [14].
  - (b) **Planted-error hit rate** is an objective anchor that needs no judge.
  - (c) **Creator confidence vs correctness** gives a Brier score, shown on the receipt as "knows what they don't know".
  - (d) **Predictive validity** (the real test): do low-scoring deliverables have more errors found later in review, QA or client feedback?
- **Freeze per receipt:** rubric version, prompt hash, model IDs and temperature, so a receipt can be re-graded and audited later.

---

## 2. Making the score trustworthy and verifiable

### 2.1 Threat model and anti-gaming

| Threat | Mitigations in the MVP | Honest residual |
|---|---|---|
| **Live AI coaching on the same screen** (overlays like Cluely, invisible to screen share [9][10][13]) | Voice viva with no text to paste. Questions refer to the creator's *own previous answers* and to specific spans in the document. Planted-error and counterfactual probes need a mental model, not a summary. Tight time per answer. Browser focus/blur and paste events logged (text mode blocks paste) | Native assessment clients can detect named tools; HackerRank's desktop mode closes Cluely [13]. We won't ship a desktop client in the MVP |
| **Second device or earpiece** | **Response-latency profile.** Coaching tools produce a "flatline" 3–5 second delay regardless of difficulty, while real answers vary with difficulty [9][10]. Speech-style shift (fewer fillers and self-corrections, list-like structure) [9][10]. Optional webcam recording for higher-assurance receipts, which Viva required [14] | Viva admits that a fluent person repeating coached answers "would not be detectable from the transcript or video alone" [14]. Signals are evidence for review, not proof, and can unfairly flag nerves, accents or second-language speakers [13] |
| **Someone else takes the viva** | Magic link to a **work email or SSO**. Optional voice-consistency check across sessions. Optional ID check (Stripe Identity $1.50 per ID+selfie verification, first 50 free) [34]. Viva switched to personalised links as the identity proof [14] | A low-assurance tier rests on email ownership alone |
| **Leaked or rehearsed questions** | Per-session seed, claim sampling and adaptive follow-ups mean there's no fixed bank to leak. Viva's point is that rehearsing explanations is itself learning [14] | Fine. It's the behaviour we want |
| **Swapping the deliverable after the defense** | SHA-256 of the exact bytes on the receipt; the verify page re-hashes the receiver's copy (§2.2) | None, if the receiver checks |
| **Grader manipulation** (prompt injection hidden in the document) | Strip and flag hidden text, white-on-white, comments; graders see the transcript plus rubric with the document only as quoted spans; injection detector | Low |

**Assurance levels shown on every receipt** (so we never overclaim):
- **L1 Self-attested:** email link, unproctored, text or voice.
- **L2 Signals:** voice, focus/paste telemetry, latency profile, optional webcam recording held for the receiver.
- **L3 Verified:** L2 plus ID check plus webcam, or a human observer on the call.

As with HireVue and Karat, **integrity signals go to a human, not to automatic rejection.** HireVue combines focus loss, copy/paste controls, identity snapshots and script-similarity checks with human review [11]. Karat uses live interviewers plus automated post-interview review, and exposes observations such as `pastedSolution`, `looksDown`, `someoneElseHeard` and `matchesOnlineSolution` through its API [12a]. We'll copy that pattern: a short list of named observations, each linked to a timestamp.

### 2.2 Verifiability for the receiver

**Receipt contents (one page plus a link):**
1. **What was defended:** file name, **SHA-256 of the exact bytes** (for a Google Doc, the revision ID plus export hash; for a PR, repo, PR number and head commit SHA), page or claim count, defense date and time.
2. **Who:** verified email or domain, assurance level (L1–L3).
3. **Result:** Understanding per section (Weak/Partial/Strong) and **Integrity signals reported separately** (Clear/Review/Concerns). Never averaged, as OralExam.ai does [17]. Planted-error hit rate and confidence calibration.
4. **Evidence:** for each question, the question, a short transcript excerpt, the grader's reason and an **audio clip timestamp**. "Replay full session" is available if the creator consented to sharing at defense time.
5. **How it was graded:** rubric version, model IDs, council agreement, whether a human audited it.
6. **Verify:** `defendit.app/r/<id>` (placeholder domain), a QR code and a "drop your copy here to check it's the same file" box that hashes in the browser, so the file never leaves the receiver's machine.

**Tamper-evidence, in increasing order of formality:**
- **MVP (week 2):** a canonical JSON receipt signed with **Ed25519**, with the public key published at `/.well-known/`. The verify page checks the signature and the file hash in the browser. Each receipt hash is also appended to an **append-only Merkle log** we run, with signed checkpoints, the Certificate Transparency and Sigstore Rekor pattern, where inclusion proofs show an entry was logged at a given time [29]. Optionally, log the receipt digest to the public Rekor instance for third-party timestamping.
- **v1:** issue the receipt as a **W3C Verifiable Credential 2.0** (a W3C Recommendation since 15 May 2025) with **Data Integrity** proofs [26][27]. Optionally use the **Open Badges 3.0** profile, which is aligned with VC 2.0 and requires verifiers to support `eddsa-rdfc-2022` and `ecdsa-sd-2023` [28]. That makes receipts portable into wallets and LinkedIn-style credential tooling, and verifiable without our servers.
- **Later:** a **C2PA** manifest embedded in the PDF deliverable itself. C2PA 2.2 supports PDF with a hard-binding data-hash assertion [35]. It's overkill for the MVP but a strong story for "this exact client deck was defended".

**What the receiver can audit:** signature valid, file hash matches, logged at time T, rubric and model versions, every score linked to verbatim evidence, plus a **"dispute or re-grade"** button that sends it to human review. Viva's experience is that evidence-linked grades are rarely disputed: 2 regrade requests, neither successful [14].

### 2.3 How similar products handle it

| Product | What they do | What we borrow / where we differ |
|---|---|---|
| **NYU Stern Viva** [14][15] | Voice examiner on ElevenLabs, 3-LLM council with deliberation, human audit on about 3%, personalised URLs for identity, webcam self-recording, under $1 grading per exam | Copy the architecture lessons. They don't produce a portable or verifiable receipt |
| **OralExam.ai** [17] | Examiner reads the submission; about 6-minute spoken conversation with live transcript; **Understanding and Authorship reported separately, no number**; evidence plus full transcript; webcam recordings with 90-day retention; Canvas integration; pricing not set | Copy the "two signals, never averaged, no fake precision" pattern. Education only |
| **Integrevise** [19] | Digital viva generated from the assignment brief, adaptive follow-ups, recorded and transcribed, rubric-aligned draft report, lecturer keeps control; Moodle, Canvas, Blackboard | Education only |
| **Prova** [18] | Tracked work sessions plus dynamic oral exams and role-plays; SOC 2, FERPA, HECVAT, VPAT; pilot term Fall 2026 | Combines process tracking with understanding. Education only |
| **Coraltalk** [20] | Voice oral exams personalised to each student's written work, LMS integration | Education only |
| **HireVue / Karat** [11][12a] | Layered integrity signals plus human review; named observations exposed by API | Copy the human-in-the-loop and named-observation pattern |
| **PR quiz tools** (sphinx-ci, Gater, Aisance, MOTHER, PR Comprehension Quiz Gate) [21–25] | Diff-based quizzes that unlock merge; mostly multiple choice or short text; usually fail-open | Shows engineers want this. Our edge is voice, adaptivity and a verifiable receipt |

**Gap we fill:** nobody issues a *portable, signed, hash-bound* proof of understanding for *workplace* deliverables, to a receiver outside the creator's institution.

---

## 3. Initial customers (ranked)

| # | Segment | Pain | Buyer | Willingness to pay (hypothesis) | How to reach them |
|---|---|---|---|---|---|
| **1** | **Small investment and research teams** (VC, PE, crypto funds and research shops; M&A advisory boutiques fit here too) | Associates write AI-assisted IC memos and models; partners sign off and carry the risk. AI research products like Messari Deep Research turn out long-form reports in 5–10 minutes [36], so "does the analyst own this?" gets sharper | Partner or Head of Research | Medium-high. Small teams with discretionary budgets; $200–500 per team per month or $20–50 per defended memo is plausible (to test) | **Luis's own network** (crypto and investment), Lisbon VC scene, intros. The fastest path to 20 real deliverables |
| **2** | **Boutique and independent consulting** | Client-facing AI errors are costly: Deloitte Australia repaid about A$98k of a A$440k fee over a report with fabricated quotes and references [37]. A receipt shown to the *client* is a selling point | Partner or practice lead | Medium-high per engagement; low volume | Independent-consultant networks, partners on LinkedIn, events |
| **3** | **Business schools and bootcamps (fast pilot channel)** | Deans at 10 top European business schools are moving to oral defenses because written work no longer shows understanding. Nova SBE's dean: "If the thesis was written by AI, it will be obvious in 30 seconds" [38]. Católica-Lisbon's AI policy requires students to be able to explain and discuss their work [39] | Programme director or course lead | Low-medium, slow procurement. **Use for volume and calibration data, not as the core business**, since this is the crowded education space [14][17]–[20] | Direct to Lisbon faculty; Le Wagon Lisbon (next AI bootcamp session starts 26 Oct 2026) [40] |
| **4** | **Engineering teams reviewing AI-written PRs and OSS maintainers** | Ghostty requires contributors to disclose AI use and *fully understand their changes without AI* [41]. curl applies extra scrutiny to AI-assisted reports and bans obvious "AI slop" [42]. In an RCT, AI-assisted devs scored 50% vs 67% on comprehension (thesis [2]) | Eng manager or CTO; maintainers (no budget) | Medium, but anchored low by free and cheap quiz tools [21–25] | GitHub Marketplace, Show HN, Lisbon and Porto scaleups, Unicorn Factory Lisboa [43] |
| **5** | **Legal and compliance teams** (later) | 2,199 court decisions involving AI hallucinations as of 16 Oct 2026, 871 involving lawyers [44]. The EU AI Act Art. 4 has required "AI literacy" measures for staff since 2 Feb 2025, documented but with no prescribed measurement [45]. A receipt is natural documentation | GC, risk or compliance lead | High, but slow sales and security reviews | Later, once L3 assurance and a SOC 2 path exist |

### 3.1 Example targets and communities (public URLs; none contacted)

| # | Target | Segment | URL | Cold-outreach angle |
|---|---|---|---|---|
| 1 | Indico Capital Partners (Lisbon VC) | 1 | https://www.indicocapital.com/about-us | "Your associates' IC memos are probably AI-assisted. Want a 7-minute defense receipt on the next 5, free?" |
| 2 | Delphi Digital (crypto research) | 1 | https://delphidigital.io/ | Human-led research is the brand; a receipt shows readers "the analyst owns this" |
| 3 | Messari (AI deep research) | 1 | https://newsletter.messari.io/p/research-reinvented-messari-s-deep-research-is-here | AI-generated reports plus "analyst-defended" receipts as a premium trust layer |
| 4 | Luis's crypto/investment network (former and current colleagues, fund contacts) | 1 | — | Warm intros; best for the first 2 pilot teams |
| 5 | Umbrex (independent ex-MBB consultants community) | 2 | https://umbrex.com/ | "Give your client a signed receipt that you defended the deck." Members are solo consultants who need trust signals |
| 6 | Eden McCallum (independent consultant network) | 2 | https://edenmccallum.com/ | Quality assurance across a distributed network of independents |
| 7 | Catalant (on-demand experts) | 2 | https://catalant.com/ | Platform-level trust signal for expert deliverables |
| 8 | Nova SBE (Lisbon) | 3 | https://www.novasbe.unl.pt | The dean already said they'll assess the "ability to defend the document" [38]. Offer a thesis-defense prep plus receipt pilot |
| 9 | Católica-Lisbon | 3 | https://intra.clsbe.lisboa.ucp.pt/current-students/master-student-affairs/dissertation/dissertation-defense | Dissertation-defense prep coach (creator side) |
| 10 | Frankfurt School, HEC Paris, Esade, Vlerick, IMD (named in GMAC report) | 3 | https://hotminute.co.uk/2026/09/24/europes-top-business-schools-bring-back-the-oral-exam/ | "You're bringing back oral exams; here's one that scales and issues a verifiable credential" |
| 11 | Le Wagon Lisbon (AI Software Dev bootcamp) | 3/4 | https://www.lewagon.com/lisbon | Students ship AI-assisted projects; "Defend your project" receipt for hiring partners |
| 12 | Ghostty maintainers | 4 | https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md | Their policy already demands contributors understand their changes; offer an optional "defended" check |
| 13 | curl project | 4 | https://curl.se/dev/vuln-disclosure.html | AI-slop reports cost maintainer time; a defense step before triage |
| 14 | Sword Health (Porto/Lisbon engineering) | 4 | https://swordhealth.com/company/careers/technology-%26-ai/b2b741fb-c2b9-4a08-9c23-0f23dfbd0a34 | Their engineering roles expect AI coding assistants; regulated health code needs owners who understand it |
| 15 | Feedzai (AI fraud prevention, Portugal) | 4/5 | https://www.linkedin.com/company/feedzai | Financial-crime code plus regulators means understanding matters |
| 16 | Unicorn Factory Lisboa (startup hub) | 4 | https://unicornfactorylisboa.com/ | One talk or demo reaches dozens of eng teams |
| 17 | Web Summit Lisbon, 9–12 Nov 2026 | all | https://websummit.com/web-summit-2026/ | In-person customer discovery 3 weeks from now; a live "defend your deck" demo booth idea |
| 18 | AI hallucination cases database (legal) | 5 | https://www.damiencharlotin.com/hallucinations/ | Data hook for legal and compliance outreach later |

---

## 4. MVP spec

### 4.1 Core flows

**Receiver ("Request a defense"), about 60 seconds:**
1. Sign in with a magic link → "New request" → paste a Doc link or PR URL, or let the creator upload.
2. Optionally pin 1–3 claims to probe, set the assurance level (L1 or L2), and set a deadline.
3. Send the link (we generate it; the receiver pastes it into their own email or Slack).
4. Get notified → open the receipt → verify (hash drop), skim evidence, replay clips, accept or dispute.

**Creator, about 10 minutes total:**
1. Open the link → confirm the deliverable (upload, Picker or PR) → see what will be shared and what stays private.
2. **Prep (optional, recommended):** a 5–10 minute Socratic coach in voice or text → gap map → "re-explain this section".
3. Mic check plus a 30-second practice question (ungraded) [14].
4. **Defense:** 6–8 minutes, about 5 claims, one question at a time, live transcript, 30-second silence tolerance, confidence slider after key answers.
5. Instant private feedback → choose to **send the receipt** (or redo once after 24 hours; the receipt then shows "attempt 2").

Self-initiated mode: the creator can also start a defense themselves and attach the receipt link to their email or PR.

### 4.2 Two-to-three-week build scope

| Week | Ship |
|---|---|
| **1** | Next.js app, auth (magic link plus Google SSO), uploads (PDF/DOCX/XLSX/MD) and Google Picker (`drive.file`), PR URL fetch; hashing; parsing into claims; probe-bank generator; text-mode viva plus prep coach; Postgres schema |
| **2** | Voice viva on ElevenLabs Agents (dynamic variables, server-side question plan and seed, single-question validator, 30-second silence); recording and transcript; timing and focus telemetry; grading council (3 models plus chair) with audit flag; **signed receipt page plus verify page** (Ed25519, in-browser hash check), Merkle log |
| **3** | Receiver dashboard (requests, receipts, dispute); integrity observations panel; consent and retention settings (default 90 days, delete on request); optional GitHub Check Run; gold-set grading harness (α computation); polish; dogfood on 5 of Luis's own documents |

**Out of scope:** Docs sidebar, Chrome extension, Slack app, VC/Open Badges issuance (v1), C2PA, ID checks (manual option only), LMS integrations, desktop proctoring client.

### 4.3 Suggested stack

- **App:** Next.js (App Router) on Vercel; Postgres (Neon or Supabase) with Drizzle; S3-compatible object storage for files and audio; a background job queue (Inngest or a simple worker) for parsing and grading.
- **Voice:** ElevenLabs Agents over WebRTC/WebSocket from the browser, behind a `VoiceProvider` adapter (OpenAI Realtime as the alternative) [1][3].
- **LLMs:** claim extraction and probes from one frontier model; council of 3 different model families plus a cheaper chair (Viva found the chair model was about 2/3 of grading cost) [14].
- **Parsing:** `pdf.js` / `pdfplumber`, `mammoth` (DOCX), SheetJS (XLSX: formulas plus named ranges), GitHub REST for the PR diff.
- **Crypto:** `@noble/ed25519` signing, SHA-256 with WebCrypto in the browser for verification; Merkle log in Postgres with signed checkpoints; VC 2.0 issuance in v1 (e.g. Digital Bazaar `vc` libs).
- **Data model (core):** `deliverable(id, sha256, source, revision, bytes_ref)`, `defense_request`, `session(seed, assurance_level, consent)`, `turn(question, answer, t_start, t_end, latency_ms, focus_events)`, `grade(model, round, claim_id, scores, evidence)`, `receipt(json, signature, log_index)`.

### 4.4 Receipt design (one screen)

```
DEFEND IT · Understanding Receipt                 ✓ Signature valid · ✓ Logged 17 Oct 2026 14:02 (Lisbon)
Deliverable: Q4_IC_Memo_ProjectX.pdf   sha256: 9f3a…c21e   [Drop your copy to verify]
Defended by: ana@fund.com (verified domain)   Assurance: L2 (voice + signals)   Attempt 1 · 7m 41s

UNDERSTANDING                        INTEGRITY SIGNALS (separate, never averaged)
 Thesis & market ......... Strong     Clear: no focus loss, no paste,
 Unit economics .......... Partial    response latency varied with difficulty
 Exit assumptions ........ Weak  ◀    (2 notes, see timeline)
 Planted error caught: 1/1  ·  Calibration: good (Brier 0.14)

EVIDENCE (5 questions)                                        ▶ replay clips (consented)
 Q3 "If the exit multiple drops from 12x to 8x, what happens to IRR?"
   "…IRR roughly halves, um, actually it drops to the low teens because…" [02:51–03:34]
   Grader: correct direction, couldn't trace which tab drives it → Partial
Graded by 3-model council + chair · rubric v0.3 · agreement high · no human audit needed
[Accept]  [Request re-grade]
```

### 4.5 Pilot success metrics (about 20 real deliverables, 2–3 teams)

| Metric | Target |
|---|---|
| Creator time-to-first-question | ≤ 90 seconds median |
| Defense completion rate (link opened → receipt sent) | ≥ 80% |
| Creator: "it helped me understand my own work better" | ≥ 60% agree |
| Prep coach opt-in rate | ≥ 40% |
| Receiver opens receipt / uses verify or evidence | ≥ 90% / ≥ 50% |
| Receiver: "changed how much I trust or what I checked" | ≥ 50% of receipts |
| **Predictive validity:** Weak sections vs errors later found in review | Weak sections have ≥ 2× the error rate of Strong |
| Council vs blind human grade (gold set ≥ 20) | Krippendorff α ≥ 0.80 |
| Disputes upheld | ≤ 10% |
| Cost per defense | ≤ $3 |
| **Commercial gate** | ≥ 1 team pays, or makes it mandatory for a class of deliverables |

---

## 5. Validation plan and key risks

**Before and while building (weeks 0–3):**
1. **10–15 receiver interviews** (partners, research heads, eng leads). Ask about times they were burned by AI-assisted work, whether they'd send a defense link, what a receipt must show, and what they'd pay.
2. **8–10 creator interviews.** What makes it feel like a credential rather than surveillance? Would they use the prep coach unprompted?
3. **Concierge test now (no code):** Luis runs 3–5 vivas by hand over a call using the probe bank, and hand-writes the receipt. This checks whether receivers value the artifact before we build the signing machinery.
4. **Web Summit Lisbon (9–12 Nov):** live demo, 20+ conversations.

**Pilot (weeks 3–7):** 2–3 teams, about 20 deliverables. Collect after-the-fact error data for predictive validity, compare against the gold set, and hold a pricing conversation at week 6.

**Key risks:**
1. **Gaming undermines the receipt.** Mitigate with assurance levels, honest labelling, voice plus adaptive and planted-error probes, and human review of flags. Accept that L1 is a signal, not proof; Viva makes the same admission [14].
2. **Creators feel surveilled or resent the friction.** Make it creator-owned: private prep, consent to share, redo option, short sessions. Frame it as "a credential you earn", not monitoring.
3. **Grader validity and fairness** (accent, second language, anxiety, slow speakers). Use a text fallback, 30-second silence, configurable pacing, gold-set checks across speaker groups, and no penalty for filler words [14][17].
4. **Engineering wedge commoditised** by free PR quizzes [21–25]. That's why it's ranked 4th; differentiate through the receipt and voice.
5. **Education competitors move into work** (Viva is "now run as a hosted service" [14]; OralExam.ai, Prova). Speed and a focus on the receiver are the moat early; network effects through receipts receivers recognise come later.
6. **Privacy and confidentiality** of client deliverables and voice data. Use zero-retention or enterprise API terms where available, 90-day default retention, EU data residency option, DPA template. Pilot only with non-regulated data at first.
7. **"Who pays" is still unproven.** The commercial gate above is the go/no-go decision.

---

## Sources

1. OpenAI API pricing (Realtime). https://developers.openai.com/api/docs/pricing ; model page https://developers.openai.com/api/docs/models/gpt-realtime-2.1
2. OpenAI, Realtime cost optimization (tokens per minute, re-sent context). https://developers.openai.com/api/docs/guides/voice-latency-cost
3. ElevenLabs Agents pricing. https://elevenlabs.io/pricing/agents ; price cut (May 2026) https://elevenlabs.io/blog/weve-lowered-api-agents-pricing-and-introduced-pay-as-you-go
4. Openbenchmarks, voice agent latency (TTFAB, phone calls). https://openbenchmarks.com/voice-agent-latency/elevenlabs
5. Vapi pricing. https://vapi.ai/pricing
6. Vapi docs pricing ($0.05/min platform). https://github.com/VapiAI/docs/blob/main/fern/pricing.mdx
7. Deepgram pricing (Voice Agent API). https://deepgram.com/pricing
8. LiveKit Agents. https://docs.livekit.io/agents/ ; pricing https://livekit.com/pricing
9. Fabric, How AI interviews detect cheating. https://fabrichq.ai/blogs/how-ai-interviews-detect-cheating-a-technical-deep-dive
10. Fabric, How to detect Cluely. https://fabrichq.ai/blogs/how-to-detect-cluely-in-interviews
11. HireVue, Cheating and fraud. https://www.hirevue.com/platform/cheating-and-fraud ; shared scripts https://www.hirevue.com/blog/hiring/how-to-detect-shared-scripts-when-interviewing-candidates
12. HireValid, Is Cluely detectable? (follow-up twice; HackerRank Desktop App Mode). https://www.hirevalid.com/guides/is-cluely-detectable
12a. Karat, Interview Integrity overview and API docs. https://customer-operations.zendesk.com/hc/en-us/articles/30928539529623-Overview-Interview-Integrity ; https://customer-operations.zendesk.com/hc/en-us/articles/30937393388311-Karat-API-documentation
13. EnTeam, Detect Cluely, Parakeet and ChatGPT in remote interviews. https://enteam.ai/resources/interview-integrity/detect-cluely-parakeet-chatgpt-remote-interviews/
14. Ipeirotis & Rizakos, *Scalable and Personalized Oral Assessments Using Voice AI* (CACM 2026). https://arxiv.org/abs/2603.18221
15. NYU Stern Viva. https://viva.stern.nyu.edu/
17. OralExam.ai. https://oralexam.ai/
18. Prova. https://prova.education/
19. Integrevise. https://www.integrevise.com/universities
20. Coraltalk. https://www.coraltalk.com/
21. sphinx-ci. https://sphinx-ci.dev/
22. Gater. https://www.usegater.app/
23. Aisance. https://aisance.dev/
24. MOTHER. https://mother.cm42.io/
25. PR Comprehension Quiz Gate (GitHub Marketplace). https://github.com/marketplace/actions/pr-comprehension-quiz-gate
26. W3C Verifiable Credentials Data Model v2.0. https://www.w3.org/TR/vc-data-model-2.0/ ; Recommendation news https://www.w3.org/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation/
27. W3C VC Data Integrity 1.0. https://www.w3.org/TR/vc-data-integrity/
28. 1EdTech Open Badges 3.0. https://www.imsglobal.org/spec/ob/v3p0/
29. Sigstore / Rekor transparency log. https://docs.sigstore.dev/logging/overview/ ; https://docs.sigstore.dev/about/security/
30. Google Workspace Marketplace app review. https://developers.google.com/workspace/marketplace/about-app-review
31. Google restricted scope verification. https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
32. Google Drive API scopes and Picker. https://developers.google.com/workspace/drive/api/guides/api-specific-auth ; https://developers.google.com/workspace/drive/picker/guides/web-picker
33. GitHub Checks and branch protection. https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks ; https://docs.github.com/en/rest/branches/branch-protection
34. Stripe Identity pricing. https://stripe.com/identity
35. C2PA Technical Specification 2.2. https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html
36. Messari Deep Research. https://newsletter.messari.io/p/research-reinvented-messari-s-deep-research-is-here
37. AP News, Deloitte Australia partial refund over AI errors (Oct 2025). https://apnews.com/article/australia-ai-errors-deloitte-ab54858680ffc4ae6555b31c8fb987f3 ; https://www.theguardian.com/australia-news/2025/oct/06/deloitte-to-pay-money-back-to-albanese-government-after-using-ai-in-440000-report
38. HotMinute on GMAC report, business schools bring back oral exams (24 Sep 2026). https://hotminute.co.uk/2026/09/24/europes-top-business-schools-bring-back-the-oral-exam/
39. Católica (UCP) Academic and Scientific Integrity Policy. https://www.ucp.pt/sites/default/files/2025-10/Academic-and-Scientific-Integrity-Policy-April25.pdf
40. Le Wagon Lisbon. https://www.lewagon.com/lisbon
41. Ghostty AI policy. https://github.com/ghostty-org/ghostty/blob/main/AI_POLICY.md
42. curl vulnerability disclosure policy (AI use). https://curl.se/dev/vuln-disclosure.html
43. Unicorn Factory Lisboa. https://unicornfactorylisboa.com/
44. Damien Charlotin, AI Hallucination Cases Database. https://www.damiencharlotin.com/hallucinations/
45. European Commission, AI Literacy Q&A (AI Act Art. 4). https://digital-strategy.ec.europa.eu/en/faqs/ai-literacy-questions-answers
46. Web Summit 2026 (9–12 Nov, Lisbon). https://websummit.com/web-summit-2026/
