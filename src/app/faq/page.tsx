// Draft, last updated 2026-10-22
import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { PriceList } from "@/components/price-list";
import {
  CHALLENGE_FINISH_HOURS_DEFAULT,
  CHALLENGE_OPT_OUT_HANDLES_MAX,
  CHALLENGE_UNCLAIMED_DAYS_DEFAULT,
} from "@/lib/challenge-public";
import { OPERATOR_EMAIL, OPERATOR_NAME } from "@/lib/operator";
import { documentTtlHours, retentionDays } from "@/lib/retention";

export const metadata: Metadata = {
  title: "FAQ · Defend It",
  description:
    "Prices, challenge links, opting out, how long a file is kept, and refunds as wallet credit.",
};

export default function FaqPage() {
  const textHours = documentTtlHours();
  const keptDays = retentionDays();

  return (
    <LegalPage
      eyebrow="FAQ"
      title="Questions"
      lede={
        <p>
          Short answers. The full rules are on the{" "}
          <a className="text-[var(--blueprint)] underline" href="/terms">
            terms
          </a>
          , and file storage is on the{" "}
          <a className="text-[var(--blueprint)] underline" href="/privacy">
            privacy page
          </a>
          .
        </p>
      }
    >
      <LegalSection title="What does it cost?">
        <PriceList />
        <p>
          During the beta, a new account gets a one-time free grant before any of these prices
          apply. Card checkout stays off until billing is turned on.
        </p>
      </LegalSection>

      <LegalSection title="What is a challenge?">
        <p>
          A challenge is a link you send to someone else. They upload a file and take the
          interview. Creating the link holds 1 challenge credit. You cannot take your own
          challenge. The person who accepts confirms they are 18 or older. Finishing does not spend
          their defense credit. You sponsored it.
        </p>
        <p>
          An unclaimed link expires after {CHALLENGE_UNCLAIMED_DAYS_DEFAULT} days. After they
          accept, they have {CHALLENGE_FINISH_HOURS_DEFAULT} hours to finish. Challenges stay off
          until the operator turns them on.
        </p>
      </LegalSection>

      <LegalSection title="Can I opt out of challenges?">
        <p>
          Yes. Opting out puts your verified email on a do-not-challenge list. You can add up to{" "}
          {CHALLENGE_OPT_OUT_HANDLES_MAX} handles. A new challenge aimed at an address on that list
          is refused, and you cannot accept one while you are opted out.
        </p>
        <p>
          You can also turn a single link down. If the sender named your verified email, the
          challenge closes and their credit is returned. The public page says closed. It does not
          say you declined. If they did not name your email, the link is only hidden for you.
        </p>
        <p>
          After you finish, you choose what the sender sees. Public includes the score. Score
          hidden shows a tier and not the number. Private keeps the receipt to yourself. The sender
          does not get the file or your answers in any of those choices.
        </p>
      </LegalSection>

      <LegalSection title="What happens to my file?">
        <p>
          The raw upload is read in memory and is not stored. We keep its SHA-256, its size, and
          its type. The extracted text is encrypted, and it is deleted when the defense finishes.
          If you never defend, that text is deleted after {textHours} hours (
          <span className="mono text-xs">DOCUMENT_TTL_HOURS</span>
          ).
        </p>
        <p>
          Your answers are not deleted at that moment. They stay encrypted for {keptDays} days from
          the session (<span className="mono text-xs">RETENTION_DAYS</span>
          ), along with the claims, the file name, and the detailed grades. Flashcards follow that
          same {keptDays}-day window. A deployment can set either clock.
        </p>
        <p>
          The receipt is kept. It has the hash, the score, the date, and the signature. It does not
          contain the file or the answers. There is no delete button. Email {OPERATOR_NAME} if you
          want an account or a receipt link taken down. The automatic job does not delete receipts
          or accounts.
        </p>
        <p>
          Abuse limits are a different row. When a salt is set they store a keyed hash of the IP
          address and a counter, not the address. Without a usable salt, that IP limit is skipped.
          The{" "}
          <a className="text-[var(--blueprint)] underline" href="/privacy">
            privacy page
          </a>{" "}
          has the same rule.
        </p>
      </LegalSection>

      <LegalSection title="Can I speak the answers?">
        <p>
          Standard can be typed or spoken. Hard and Expert are spoken, unless you choose the text
          option for accessibility. A spoken interview starts when voice is configured. Otherwise
          you answer on the page.
        </p>
      </LegalSection>

      <LegalSection title="How do refunds work?">
        <p>
          A refund is credit in the wallet. Declined, expired, and revoked challenges, and
          abandoned defenses, return the held credit. The card is not refunded. If a consumer-law
          right requires money back, the refund is money.
        </p>
        <p>
          Card refunds, disputes, and the customer portal are not available. The{" "}
          <a className="text-[var(--blueprint)] underline" href="/terms">
            terms
          </a>{" "}
          say what will apply when card payments open.
        </p>
      </LegalSection>

      <LegalSection title="How do I contact you?">
        <p>
          {OPERATOR_NAME} ·{" "}
          <a className="text-[var(--blueprint)] underline" href={`mailto:${OPERATOR_EMAIL}`}>
            {OPERATOR_EMAIL}
          </a>
        </p>
      </LegalSection>
    </LegalPage>
  );
}
