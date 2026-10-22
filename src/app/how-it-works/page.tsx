// Draft, last updated 2026-10-22
import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { GRADING_TEMPERATURE } from "@/lib/llm";
import { OPERATOR_EMAIL } from "@/lib/operator";
import { RUBRIC_VERSION } from "@/lib/rubric";
import { documentTtlHours, MAX_UPLOAD_BYTES, retentionDays } from "@/lib/retention";
import {
  CHALLENGE_STRONG_MIN_SCORE,
  DEFENDED_MIN_SCORE,
  PARTIAL_CLAIM_SCORE,
  PARTIAL_LEVEL,
  PARTIAL_MIN_SCORE,
  STRONG_CLAIM_SCORE,
  STRONG_LEVEL,
} from "@/lib/score-bands";

export const metadata: Metadata = {
  title: "How it works · Defend It",
  description:
    "Upload a file, sit a file-grounded interview, and get an Ed25519-signed receipt. What the score means, and how to check the file hash.",
};

export default function HowItWorksPage() {
  const maxMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
  const textHours = documentTtlHours();
  const keptDays = retentionDays();

  return (
    <LegalPage
      eyebrow="Sheet 02 · Method"
      title="How it works"
      lede={
        <p>
          You upload a file, answer questions about that file, and get a signed receipt for that
          one sitting. The receipt is evidence of the interview. It is not a certification, and it
          is not proof you wrote the file.
        </p>
      }
    >
      <LegalSection title="Upload a file">
        <p>
          Drop a PDF, DOCX, XLSX, CSV, TXT, or MD, up to {maxMb} MB. The bytes are read in memory.
          They are not written to disk. Defend It keeps the SHA-256 of those exact bytes, the size,
          and the file type.
        </p>
        <p>
          The extracted text is encrypted. It is deleted when you finish the defense. If you only
          practise and never defend, that text is deleted after {textHours} hours. Your answers are
          a different clock: they stay encrypted for {keptDays} days from the session, then they
          are deleted too. The receipt is kept. Details and the privacy page are linked from the{" "}
          <a className="text-[var(--blueprint)] underline" href="/faq">
            FAQ
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection title="The interview">
        <p>
          The questions are about claims in your file. Which claims are asked, and where an error
          is planted, is chosen in code from a seed. The model writes the wording. It does not
          decide the score, and it does not choose to skip a claim on its own.
        </p>
        <p>
          Standard asks why the key claims hold. Hard adds what-ifs and a planted error. Expert
          pushes on edge cases. Learn, if you use it first, stays private. Only Defend produces a
          receipt.
        </p>
      </LegalSection>

      <LegalSection title="Council grading">
        <p>
          Several models score the answers separately, at temperature {GRADING_TEMPERATURE}. The
          receipt uses the middle score on each point, then gives harder questions more weight. The
          rubric is {RUBRIC_VERSION}. Each stored grade keeps the model id, the temperature, and
          the seed.
        </p>
        <p>
          A deployment will not grade if one of the models is a router that can change per request,
          or if fewer than two models are pinned. If a defense runs past its cost cap, one smaller
          model may grade it alone. The receipt names that model and marks the grade as a budget
          fallback.
        </p>
        <p>
          If the graders are far apart on a question, you get one follow-up. The receipt can then
          be flagged for a person to look at. That flag is separate from the score.
        </p>
      </LegalSection>

      <LegalSection title="Scores and tiers">
        <p>
          Each answer is scored from 0 to 4 on accuracy, reasoning, transfer, catching a planted
          error, and ownership. An answer is Strong when those levels average at least {STRONG_LEVEL}.
          It is Partial at {PARTIAL_LEVEL} or above. Below that it is Weak. The model does not type
          the percentage. The code computes it.
        </p>
        <div className="titleblock">
          <div>
            <small>Defended</small>
            <b>{DEFENDED_MIN_SCORE}+</b>
          </div>
          <div>
            <small>Partially defended</small>
            <b>
              {PARTIAL_MIN_SCORE}–{DEFENDED_MIN_SCORE - 1}
            </b>
          </div>
          <div>
            <small>Not defended</small>
            <b>under {PARTIAL_MIN_SCORE}</b>
          </div>
          <div>
            <small>Strong claim</small>
            <b>{STRONG_CLAIM_SCORE}+</b>
          </div>
        </div>
        <p>
          The receipt number runs from 0 to 100. {DEFENDED_MIN_SCORE} and above is Defended.{" "}
          {PARTIAL_MIN_SCORE} to {DEFENDED_MIN_SCORE - 1} is Partially defended. Under{" "}
          {PARTIAL_MIN_SCORE} is Not defended. On the receipt chart, a claim at {STRONG_CLAIM_SCORE}{" "}
          or above is strong, and {PARTIAL_CLAIM_SCORE} or above is partial.
        </p>
        <p>
          A published challenge uses a coarser label on the same number. {CHALLENGE_STRONG_MIN_SCORE}{" "}
          and above is Defended · Strong. {DEFENDED_MIN_SCORE} to {CHALLENGE_STRONG_MIN_SCORE - 1} is
          Defended. Under {DEFENDED_MIN_SCORE} is Still sharpening. A score-hidden challenge shows
          that label and not the number.
        </p>
      </LegalSection>

      <LegalSection title="What the receipt proves">
        <p>
          The receipt proves that one signed-in person took one interview about one file, on the
          date printed, and received the score printed. The file is the bytes whose SHA-256 matches
          the fingerprint. The signature is Ed25519. The public key is published at{" "}
          <span className="mono text-xs">/.well-known/defend-it-pubkey.json</span>.
        </p>
        <p>
          It does not prove authorship. It does not prove the file is true. It does not licence you
          to do anything. Integrity notes (timing, paste, focus) sit beside the score and are not
          folded into it. The receipt holds no document text, no answers, no file name, and no
          email.
        </p>
      </LegalSection>

      <LegalSection title="Check a receipt">
        <p>
          Open the receipt at <span className="mono text-xs">/r/[id]</span>. The page shows the
          outcome, the score, the date, whether the signature checks, and the SHA-256.
        </p>
        <p>
          To check a copy of the file, use the verify link on that page,{" "}
          <span className="mono text-xs">/verify/[id]</span>. Drop the file there. The hash is
          computed in your browser, and the file is not uploaded. A match means those bytes are the
          ones that were defended. A mismatch means the file was edited or swapped.
        </p>
        <p>
          Questions about a score:{" "}
          <a className="text-[var(--blueprint)] underline" href={`mailto:${OPERATOR_EMAIL}`}>
            {OPERATOR_EMAIL}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
