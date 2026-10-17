# Defend It: Thesis (draft)

*Luis · draft, 17 Oct 2026 · bracketed numbers refer to the sources listed at the end*

## One-line thesis

AI makes good output nearly free, so what gets scarce is a person who can explain, defend and judge it. **Defend It helps creators really understand their AI-assisted work, then shows the people receiving it that they do.**

## The problem

We are building a car too advanced for anyone to drive. People can produce polished work they can't justify, and their judgment fades from lack of use. The evidence points one way:

- **Learning suffers.** In a field RCT with about 1,000 students, unrestricted GPT-4 raised practice scores by 48%. Once access was removed, those students scored **17% worse** than students who never had it. A version that gave hints instead of answers largely removed the harm [1].
- **Comprehension suffers.** Developers learning a new library with AI scored **50% vs 67%** on comprehension, with the biggest gap in debugging. Developers who used AI to get explanations kept their understanding; those who handed off the work did not [2].
- **Judgment and self-assessment suffer.** Among knowledge workers, more confidence in AI went with less critical thinking [3]. ChatGPT users scored about 3 points higher on LSAT problems but overestimated their score by about 4 points [6].
- **Skills fade where it matters.** After AI-assisted colonoscopy was introduced, endoscopists' detection rate *without* AI fell from 28.4% to 22.4% (observational) [7]. Bainbridge's "ironies of automation" says the rare failures need *more* skill, just as automation wears it down [9].

## Why now

1. **Detection has failed as a trust mechanism.** OpenAI shut down its AI-text classifier, which caught only 26% of AI text and falsely flagged 9% of human text [10]. Detectors flagged more than half of essays by non-native English writers as AI-written [11].
2. **The question is changing.** Tools like Interview Coder feed candidates live answers, and Google, Cisco and McKinsey have brought back in-person rounds [12][13]. Meta now allows AI in some coding interviews and grades *how* candidates use it to understand and verify code [14]. The question is moving from "did you use AI?" to "do you understand what you're shipping?"
3. **The method already works, in classrooms.** NYU Stern's voice-AI Viva has examined more than 1,000 students at under $1 per exam, and most students said it tested real understanding [18][19]. OralExam.ai reports Authorship and Understanding separately [20]. Nobody has packaged this for knowledge work.

## The product: one loop, two sides

**Learn → Defend → Receipt.**

**Creator side: understand it, faster.** Load your AI-assisted memo, model, code change or analysis. A Socratic coach asks you to explain it back, pushes back, poses counterfactual "what if this assumption changes?" probes, plants errors for you to catch, and asks you to rate your confidence. It ends with a **gap map** of weak sections. Voice mode lets you debate it on a walk. This is built on well-established learning science: retrieval practice beats re-study (56% vs 42% recall after a week) [29], and self-explanation and teaching build stronger mental models [31][32].

**Receiver side: trust it.** Before handing off the work, the creator takes a 5–8 minute adaptive AI viva grounded in the document: why this assumption, what if X changes, find the planted error, how confident are you. The manager, client, reviewer or investor gets a one-page **Understanding Receipt**. It shows a score per section, flagged weak areas, a calibration score and key transcript clips, kept separate from authorship [20].

**Why one product.** The receipt gives people a reason to learn, and the coach gets them ready to pass. Each side solves the other's main weakness. Standalone tutors are easy to skip and produce nothing a recipient can see [15][16]. Standalone exams test understanding without building it.

## Wedge customer and who pays

- **First users:** analysts and associates in consulting, finance, legal and strategy teams, plus engineering teams reviewing AI-written pull requests.
- **Who pays:** the manager or practice lead who signs off on the work and carries the risk of AI-assisted decisions. Individuals rarely pay to "get smarter" (research brief, §5). Organizations already pay for risk control.
- **Start with high-stakes deliverables only**, such as client memos, investment models and production PRs, where adding 8 minutes is clearly worth it.
- **Later:** a consumer "walk and debate" app as the front door, and a "judgment gym" for regulated reviewers such as clinicians and compliance staff [7][9].

## What exists and why it falls short

| Category | Examples | Gap |
|---|---|---|
| Socratic tutors | ChatGPT Study Mode, NotebookLM, Khanmigo [15][16][17] | Help the learner but give the recipient nothing; easy to skip when rushed |
| AI oral exams | NYU Viva, OralExam.ai, Integrevise, Coraltalk, Prova [18]–[23] | Built for education and run by institutions; none target managers or clients |
| Process recording | Grammarly Authorship, Turnitin Clarity, Draftback [25]–[27] | Prove effort and provenance, not understanding; you can retype an AI answer |
| Spaced repetition | Anki, RemNote (FSRS) [28] | Test memory, not reasoning or judgment |

## MVP scope

- A Google Docs or GitHub PR add-on, plus a shareable receipt link.
- An LLM question generator grounded in the document, covering explain-back, counterfactuals, planted errors and confidence ratings.
- A multi-model rubric grader with human review of disputed scores, following Viva's approach [18].
- Creator prep mode with voice and a gap map.
- A pilot with 2–3 teams.

**Out of scope for now:** certification, consumer app, vertical drill libraries.

## Key risks and open questions

- **Gaming.** A second AI can coach someone through a text viva in real time [12]. Live voice, time limits, adaptive follow-ups and in-context questions make cheating costly but don't stop it. *How much does the receipt still mean if gaming is possible?*
- **Understanding vs memorization.** Immediate scores may not predict lasting skill [2]. Rely on transfer probes (counterfactuals, planted errors) and re-test over time.
- **Motivation.** Users like cognitive forcing functions less, and they help most the people who already enjoy thinking [36]. Adoption probably needs the recipient to require it, or a real payoff such as status or speed.
- **Privacy and surveillance feel.** It must be started and owned by the user, with local data and the user choosing when to share, following Grammarly's model [25].
- **Grading reliability and fairness.** LLM graders disagree [18]. Voice adds accent, language and anxiety bias, echoing detector bias [11].
- **Credential value.** No standard says what a receipt certifies. Its worth depends on recipients trusting the issuer.

## Next steps for validation

1. **10–15 interviews with receivers** (managers, partners, engineering leads, investors). Have they been burned by AI-assisted work nobody understood? Would they require a receipt? Would they pay?
2. **10 interviews with creators.** Would they use prep mode by choice? What would make a receipt feel like a credential rather than surveillance?
3. **Concierge pilot.** Run manual or semi-automated vivas on 20 real deliverables with 2 teams. Measure whether receivers' trust and decisions change and whether low scores predict real errors.
4. **Prototype the questioning engine** in voice and test inter-grader agreement against human raters.
5. **Decision gate:** at least one team willing to pay or make it mandatory for a class of deliverables.

---

**Sources** (numbers follow the research brief)
[1] Bastani et al., PNAS 2025 · [2] Shen & Tamkin, Anthropic 2026 · [3] Lee et al., CHI 2025 · [6] Fernandes et al., Computers in Human Behavior 2025 · [7] Lancet Gastroenterology & Hepatology 2025 · [9] Bainbridge, Automatica 1983 · [10] OpenAI AI classifier (discontinued 2023) · [11] Liang et al., Patterns 2023 · [12] CNBC 2025 · [13] Computerworld 2025 · [14] Hello Interview, Meta AI-enabled interview · [15] OpenAI Study Mode · [16][17] Google NotebookLM · [18] NYU Stern Viva · [19] Ipeirotis & Rizakos, CACM 2026 · [20] OralExam.ai · [21] Integrevise · [22] Coraltalk · [23] Prova · [25] Grammarly Authorship · [26] Turnitin Clarity · [27] Draftback · [28] RemNote FSRS · [29] Roediger & Karpicke 2006 · [31] Chi et al. 1994 · [32] Fiorella & Mayer 2013 · [36] Buçinca et al., CSCW 2021
