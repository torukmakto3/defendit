// Draft, last updated 2026-10-22
import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal-page";
import { PriceList } from "@/components/price-list";
import { betaBudgetEur, betaDefenseEur } from "@/lib/beta";
import {
  CHALLENGE_DAILY_PER_CREATOR_DEFAULT,
  CHALLENGE_FINISH_HOURS_DEFAULT,
  CHALLENGE_OPEN_PER_CREATOR_DEFAULT,
  CHALLENGE_OPEN_PER_DEFENDER_DEFAULT,
  CHALLENGE_OPT_OUT_HANDLES_MAX,
  CHALLENGE_UNCLAIMED_DAYS_DEFAULT,
} from "@/lib/challenge-public";
import { OPERATOR_EMAIL, OPERATOR_NAME } from "@/lib/operator";
import { BETA_GRANT, betaDefenseCredits, formatEur, ONWARD_CHALLENGE_CREDITS } from "@/lib/plans";

export const metadata: Metadata = {
  title: "Terms of Service · Defend It",
  description:
    "Beta credits, euro prices, refunds as wallet credit, what a signed receipt is, challenge rules, and Portuguese law.",
};

export default function TermsPage() {
  const defenses = betaDefenseCredits();
  const budget = formatEur(Math.round(betaBudgetEur() * 100));
  const perDefense = formatEur(Math.round(betaDefenseEur() * 100));

  return (
    <LegalPage
      eyebrow="Terms"
      title="Terms of Service"
      lede={
        <>
          <p>
            These terms cover the beta, credits, and what a receipt means. {OPERATOR_NAME} operates
            Defend It. Buying credits, or using a free beta credit, means you agree to them.
          </p>
          <p>
            How a file is kept is on the <a className="text-[var(--blueprint)] underline" href="/privacy">privacy page</a>.
            How the interview and the score work is on{" "}
            <a className="text-[var(--blueprint)] underline" href="/how-it-works">How it works</a>.
          </p>
        </>
      }
    >
      <LegalSection title="Beta">
        <p>
          Defend It is a beta. Features can change, pause, or be removed. Card checkout stays off
          until billing is turned on.
        </p>
        <p>
          The first time a signed-in account needs credits, it receives {defenses}{" "}
          {defenses === 1 ? "defense" : "defenses"}, {BETA_GRANT.challenge} challenges, and{" "}
          {BETA_GRANT.learnSlots} Learn slots. That grant happens once. While billing is off, the
          next defense after those are spent is refused.
        </p>
        <p>
          Sponsored defenses can also stop sooner, when a shared trial budget of {budget} is used.
          Each sponsored defense counts {perDefense} against that budget. Credits already on the
          account can still be spent.
        </p>
      </LegalSection>

      <LegalSection title="Prices">
        <PriceList />
        <p>
          Unused defenses and challenges that came with a subscription expire when the plan renews.
          They are not added to the next period. Credits you bought, including packs, are not
          cleared by a renewal. You can cancel Pro at the end of the period you already paid, from
          the customer portal.
        </p>
      </LegalSection>

      <LegalSection title="Refunds">
        <p>
          The usual refund is credit in your wallet. The card is not refunded, and the card fee
          stays with the payment processor. A declined challenge, an expired challenge, a challenge
          the sender revokes while it is still open, or a defense you abandon, returns the held
          credit this way.
        </p>
        <p>
          A refund back to the card is the exception. It removes the unspent credits from that
          purchase. The balance is not taken below zero. Credits you already spent are not pulled
          from a different grant. A card dispute does the same to the remaining credits from that
          purchase, and the account can be flagged.
        </p>
        <p>
          If you are a consumer in the EU, a right the law still gives you is not replaced by
          wallet credit. Where the law requires money back, including a withdrawal right that still
          applies, the refund is money. A consumer can sometimes agree to receive digital credits
          immediately and give up the 14-day withdrawal right. That agreement has to be separate
          and clear. This page does not collect it.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>Upload a file only if you have the right to give it to us for this interview.</p>
        <p>
          Do not send a challenge to harass someone, or to someone who has opted out. Do not take
          the interview in someone else&apos;s place. The receipt is about the person who sat the
          interview and the file they uploaded.
        </p>
        <p>
          Do not attack the service, interfere with another person&apos;s defense, or upload
          unlawful material. We can refuse a file, close a challenge, or stop an account that
          breaks these rules.
        </p>
      </LegalSection>

      <LegalSection title="The receipt">
        <p>
          A receipt is a record of one interview about one file. The file is identified by the
          SHA-256 of those exact bytes. The receipt carries the score, the date, and an Ed25519
          signature.
        </p>
        <p>
          It is not a certification, a diploma, or a professional licence. It is not proof that you
          wrote the file, that the file is correct, or that you will do as well on a different day.
          A name on the receipt is optional and self-reported. Sign-in shows control of an email.
          It does not check a passport.
        </p>
        <p>
          Notes about timing, paste, and focus are reported beside the score. They are not part of
          the understanding score.
        </p>
      </LegalSection>

      <LegalSection title="Challenges">
        <p>
          A challenge is a link. Creating one holds 1 challenge credit from the sender. The person
          who accepts uploads a file and takes the interview. They confirm they are 18 or older.
          The sender pays for that defense. The person who finishes is given {ONWARD_CHALLENGE_CREDITS}{" "}
          challenge {ONWARD_CHALLENGE_CREDITS === 1 ? "credit" : "credits"}. You cannot accept a
          challenge you created, including one paid with the same card. The person who accepts does
          not spend a defense credit.
        </p>
        <p>
          An unclaimed link expires after {CHALLENGE_UNCLAIMED_DAYS_DEFAULT} days. After you accept,
          you have {CHALLENGE_FINISH_HOURS_DEFAULT} hours to finish. You can hold{" "}
          {CHALLENGE_OPEN_PER_DEFENDER_DEFAULT} unfinished{" "}
          {CHALLENGE_OPEN_PER_DEFENDER_DEFAULT === 1 ? "challenge" : "challenges"} at a time. A sender
          can have {CHALLENGE_OPEN_PER_CREATOR_DEFAULT} open at once, and can create{" "}
          {CHALLENGE_DAILY_PER_CREATOR_DEFAULT} a day. The same person is not challenged twice in one
          day by the same sender. Challenges stay off until the operator turns them on.
        </p>
        <h3 className="text-lg font-bold text-[var(--ink)]">Opting out</h3>
        <p>
          You can opt out. Your verified email goes on a do-not-challenge list, and you can add up
          to {CHALLENGE_OPT_OUT_HANDLES_MAX} handles. A new challenge aimed at an email or handle on
          that list is refused. While you are opted out, you cannot accept a challenge.
        </p>
        <p>
          You can also turn one link down. If your verified email matches the email the sender
          named, the challenge closes and the held credit goes back. The public page says the
          challenge is closed. It does not say you declined. If you are not that email, turning the
          link down only hides it for you. It stays open for someone else. A handle cannot close a
          challenge, because the account does not verify handles.
        </p>
        <h3 className="text-lg font-bold text-[var(--ink)]">What the sender sees</h3>
        <p>
          Before anyone finishes, the sender sees the subject, the note they wrote, and the status
          of the link. They do not receive the file or the answers.
        </p>
        <p>
          After the interview, you choose what is published. Public shows the receipt, the score,
          and the tier. Score hidden shows the tier and hides the number, including on the public
          page data. Private tells the sender you kept the result private, and other people get
          nothing. You can still open your own receipt. None of these pages include the file, the
          claims, or the answers.
        </p>
      </LegalSection>

      <LegalSection title="Liability">
        <p>
          The beta is provided as available. A score can be wrong. Someone who relies on a receipt
          to hire, pay, or publish does that for themselves.
        </p>
        <p>
          To the extent Portuguese and EU law allow it, {OPERATOR_NAME} is not liable for lost
          profit, a lost deal, or a decision another person makes from a receipt. Nothing here
          limits liability for death or personal injury caused by negligence, for fraud, or for a
          duty consumer law says a contract cannot limit.
        </p>
        <p>
          For other claims, liability is limited to what you paid for Defend It credits in the 12
          months before the claim. If you have only used the free beta, that cap is zero, except
          where the law does not allow a zero cap.
        </p>
      </LegalSection>

      <LegalSection title="Law">
        <p>
          These terms are governed by Portuguese law. If you are a consumer in the European Union,
          you keep the mandatory protections of the country where you live. You can bring a claim
          in the courts of that country. You can also use the Portuguese courts. Those rights are
          not waived here.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
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
