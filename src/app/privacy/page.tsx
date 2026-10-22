import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy · Defend It",
  description: "What Defend It stores, how long it is kept, and how to ask for deletion.",
};

/** Shown on the page and locked by the render test. */
export const PRIVACY_UPDATED = "22 October 2026";

export default function PrivacyPage() {
  return (
    <div className="shell grid max-w-3xl gap-8">
      <header className="grid gap-3">
        <span className="eyebrow">Sheet 00 · Privacy</span>
        <h1 className="text-3xl font-bold sm:text-4xl">Privacy and retention</h1>
        <p className="text-[var(--ink-2)]">
          What the app stores, who else sees the text, and how long each piece is kept. This page
          describes the software as it runs today.
        </p>
        <p className="text-sm text-[var(--ink-2)]">
          Last updated <time dateTime="2026-10-22">{PRIVACY_UPDATED}</time>.
        </p>
      </header>

      <section className="panel grid gap-3 p-5 sm:p-6">
        <h2 className="text-xl font-bold">What this is, and what it is not</h2>
        <p>
          Defend It asks you to explain a file you upload, then signs a receipt for that defense. It
          is not an AI detector. Using a model to write the file is allowed, and the product does
          not try to tell whether you did.
        </p>
        <p>This page is not a claim of compliance with the EU AI Act.</p>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-bold">Where it lives</h2>
        <p>
          The website runs on Vercel. The Vercel config pins the app to region <span className="mono">iad1</span>{" "}
          (US East). Account and defense data go into Postgres when <span className="mono">DATABASE_URL</span>{" "}
          is set. The project is set up for a pooled serverless Postgres, and the sample environment
          file names Neon, Vercel Postgres, or Supabase as that host. The code does not record
          which of those hosts production uses. With no <span className="mono">DATABASE_URL</span>, the
          app uses a SQLite file on the machine instead.
        </p>
        <p>
          The raw uploaded file is parsed in memory and is not written to disk or to the database. We
          keep its SHA-256, its size in bytes, and its type.
        </p>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-bold">What we store, and for how long</h2>
        <p>
          Two clocks cover most of the file. <span className="mono">DOCUMENT_TTL_HOURS</span> defaults to
          72 hours. <span className="mono">RETENTION_DAYS</span> defaults to 30 days. A deployment can
          change either one. A daily job at 03:17 UTC (<span className="mono">/api/cron/purge</span>), plus
          an hourly cleanup inside the app, clears what has expired. Reads also treat expired text as
          gone if that job is late.
        </p>

        <h3 className="text-lg font-bold">Account</h3>
        <p>
          Your sign-in email, stored in lowercase, and an optional display name. The row is created the
          first time you sign in with Google or with an email link, and it is kept until someone
          deletes it. Nothing in the app deletes accounts on a timer.
        </p>
        <p>
          The session cookie (<span className="mono">di_session</span>) lasts 30 days. It is HTTP-only.
          The database stores only a SHA-256 of the cookie value. An email sign-in link lasts 15
          minutes, works once, and is stored only as a SHA-256 plus the email. Expired sessions and
          links are removed by the purge job. Google sign-in, when it is configured, also sets a
          10-minute HTTP-only cookie (<span className="mono">di_google_oauth</span>) for the handshake.
          We keep the verified email Google returns and, on the first sign-in, the name Google sends.
          We do not store a Google account id.
        </p>
        <p>
          The Day or Night choice is saved in this browser&apos;s local storage (<span className="mono">defend-it:theme</span>).
          It is not sent to the server.
        </p>

        <h3 className="text-lg font-bold">The file, the answers, and the scores</h3>
        <p>
          Extracted text, the claim list, the file name, the question plan, your Learn and Defend
          answers, and the Learn gap map are encrypted with AES-256-GCM before they are stored. The
          extracted text is deleted when the defense is finished. If you only practise and never
          defend, that text is deleted after 72 hours. The file name and the claims stay until the
          30-day retention window, then the purge clears them. The SHA-256, the byte length, and the
          file type stay on the deliverable row.
        </p>
        <p>
          Your answers are not deleted at that moment. They stay encrypted until the session&apos;s
          retention window closes (30 days from when the session started, unless{" "}
          <span className="mono">RETENTION_DAYS</span> is set differently). The purge then clears the
          answers, the question plan, and the gap map. Until then, an admin account can open the
          session and read them.
        </p>
        <p>
          Before the extracted text is deleted, the app saves a set of flashcards so Learn can
          continue. The question, the answer, and the source line on each card are encrypted. Those
          cards are deleted with the deliverable&apos;s 30-day window. A set rebuilt after that window
          gets a new window of the same length. The raw document text is not kept for that extra time.
          The card&apos;s scheduling state (when it is due) is stored next to the encrypted text.
        </p>
        <p>
          Each grader&apos;s number, model id, provider, temperature, and seed are stored in the clear.
          The detailed grade, which can quote an answer, is encrypted and cleared with the session
          after the retention window. The numeric score on the grade row is not cleared. If a person
          reviews the session, their score, name, and notes are stored. The notes are cleared with the
          session. The score and the name are not.
        </p>
        <p>
          A precomputed first question is stored encrypted on the defense link. The purge job does not
          clear it. Optional notes on a &quot;request a defense&quot; link are stored as plain text and
          are not cleared either. A file you drop yourself is titled &quot;Private deliverable&quot;
          rather than the file name.
        </p>
        <p>
          Timing, paste, and focus observations are stored as plain text on the session and are not
          cleared by the purge. They are reported separately from the understanding score. The signed
          receipt always includes the status word (Clear, Review, or Concerns). When the paste count
          or the focus-loss count is above zero, that number is signed on the receipt too. The timing
          stays off the receipt.
        </p>

        <h3 className="text-lg font-bold">Challenge links</h3>
        <p>
          Challenge links (<span className="mono">/c/</span> plus an 8-character slug) exist in the code and
          stay off unless <span className="mono">CHALLENGES_ENABLED</span> is set. A challenge row stores the
          subject, an optional note, an optional source URL, an optional name or email hint, the difficulty,
          who created it, and who accepted it. Those fields are plain text. The purge job does not delete the
          challenge, the opt-out list, or the event log.
        </p>
        <p>
          The open page shows the subject, the note, the source link, the hint, the difficulty, the
          challenger&apos;s display name (or &quot;A Defend It user&quot;), and the sponsor line. It does not
          show a document. The person who accepts uploads their own file, and that file follows the same
          clocks as any other defense.
        </p>
        <p>
          After the defense, that person chooses public, public without the score, or private. A public
          result shows a tier (Defended · Strong, Defended, or Still sharpening), the score out of 100, the
          subject, a short legend of those bands, the sponsor line, and a link to verify the signed receipt.
          Public without the score shows the tier and the subject, and leaves the number off the page, the
          share card, and the public JSON. The receipt and its PDF stay off that response too. A private
          result is not shown to anyone else. The defender can still open their own receipt. None of these
          pages include the file, the claims, or the answers. A challenge someone turns down is stored, and
          the public page says only that it is closed.
        </p>
        <p>
          Opting out stores the account, the sign-in email, and any handles added to the do-not-challenge
          list. That list is not deleted on a timer.
        </p>
        <p>
          The event log records views, accepts, finished defenses, publish choices, share clicks, reports,
          and published-result views. A view or a share from a signed-in account stores that account id. A
          view or a share with no session stores no account id. A published-result view stores the account
          id, or the raw IP address when there is no session, so the same account or address is counted once.
          A report can store a short note. The purge job leaves these rows in place.
        </p>

        <h3 className="text-lg font-bold">The signed receipt</h3>
        <p>
          The receipt is kept. The purge job does not delete it, and anyone with the link can read it.
          It does not contain the file, the file name, your email, or your answers. It is signed with
          Ed25519 and contains the receipt id, the time, the difficulty, the score, the outcome
          (Defended, Partially defended, or Not defended), how many claims fell in each band, optional
          per-claim scores as numbers only, whether the interview was typed or spoken, the SHA-256 and
          byte length of the file, the rubric version, the grader model ids with temperature and seed,
          a mark when a grader was the cheaper model used because the defense hit its cost cap, the
          integrity status, the paste count and the focus-loss count when either is above zero, the
          attempt number, and assurance level L1. Your display name is on the receipt only if you tick
          the box to show it.
        </p>

        <h3 className="text-lg font-bold">Model call logs and cost</h3>
        <p>
          Each model call records a purpose label, the provider, the model id, token counts, and a
          dollar cost (the provider&apos;s figure, or an estimate from the token counts). The prompt
          and the model&apos;s reply are not stored in that log. Session rows also keep running token
          and cost totals, a cost cap for that defense, and, if a spoken interview ran, how many
          seconds it used and an estimated voice cost. Those rows are not deleted by the purge job.
          While a call is in flight, a short-lived reservation stores a dollar amount for the cap. It
          holds no document text. The reservation is removed when the call finishes. One older than
          two minutes no longer counts toward the cap, and the next reservation for that defense
          deletes it.
        </p>
        <p>
          Stage timings (how long upload, questions, grading, and signing took) are kept. They record
          a stage name and a duration, not the file.
        </p>
        <p>
          Abuse limits store a SHA-256 of the IP address and a counter. The address itself is not
          stored. Those rows are deleted about two days after the window starts.
        </p>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-bold">Who sees the text</h2>
        <p>
          The configured language-model provider receives the text for that step: an excerpt of the
          file and the claims for coaching and flashcards, the claims while questions are written, and
          each claim plus your answer while grading. Grading does not send the raw file. A live call
          is sent only when that provider enforces zero retention on the request, or the model runs on
          a machine we control:
        </p>
        <ul className="grid list-disc gap-2 pl-5">
          <li>
            Liquid Inference (<span className="mono">router.inference.ai.exchange</span>) sends{" "}
            <span className="mono">retention_policy: none</span> and requires the provider claim{" "}
            <span className="mono">zero_retention</span> unless <span className="mono">LIQUID_REQUIRE_CLAIMS</span>{" "}
            is changed. A request no matching provider can serve fails instead of running somewhere else.
          </li>
          <li>
            OpenRouter is restricted to zero-data-retention endpoints (<span className="mono">provider.zdr</span>{" "}
            and <span className="mono">data_collection: deny</span>).
          </li>
          <li>Ollama, or another compatible server on localhost, is treated as local.</li>
          <li>
            Groq, OpenAI, and Anthropic cannot enforce zero retention in this app. They are refused
            unless the operator sets <span className="mono">LLM_ALLOW_UNVERIFIED_RETENTION=1</span>.
          </li>
          <li>
            With no provider keys, or with <span className="mono">MOCK_LLM=1</span>, scoring stays on
            this server and no document is sent out.
          </li>
        </ul>
        <p>
          If email sign-in is configured, the one-time link is sent through Resend. Resend receives
          the destination address and the link. Google, when you use it to sign in, receives the
          sign-in and returns the verified email.
        </p>
        <p>
          Typed answers are the web default (<span className="mono">VOICE_PROVIDER</span> defaults to
          text). Hard and Expert defenses are marked as a voice channel unless you choose to type. A
          spoken interview starts only when LiveKit is configured. Audio then goes to LiveKit. With a
          Deepgram key, speech-to-text and the Deepgram voice send <span className="mono">mipOptOut</span>{" "}
          so Deepgram is asked not to use the audio to improve its models. Without that key, speech
          uses LiveKit Inference. The spoken answer is stored as text, the same way a typed answer is.
          The ElevenLabs and OpenAI Realtime adapters in the web app are not implemented.
        </p>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-bold">Cookies and counts</h2>
        <p>
          No third-party trackers or advertising cookies. The cookies this site sets are the sign-in
          session and, during Google sign-in, the short handshake cookie. There is no tracking cookie.
          Funnel counts for challenge links are the events described above, stored in our own database.
        </p>
      </section>

      <section className="grid gap-3">
        <h2 className="text-xl font-bold">Deleting your data</h2>
        <p>
          There is no delete button. Signing out ends the session cookie on this browser. It does not
          delete the account, the file text, the answers, or the receipt. This site does not publish a
          contact address in the app. To ask for the account for your sign-in email to be removed,
          contact the operator and include that email. Say so if you also want a receipt link taken
          down: the retention job does not delete receipts, and a receipt someone already copied still
          verifies.
        </p>
      </section>
    </div>
  );
}
