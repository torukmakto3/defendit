import Link from "next/link";

export default function HomePage() {
  return (
    <div className="shell">
      <section className="relative min-h-[72vh] overflow-hidden rounded-2xl panel px-6 py-14 sm:px-12">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%231f4d2e' fill-opacity='0.06'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
          }}
        />
        <div className="relative max-w-2xl">
          <p className="brand animate-rise text-5xl leading-none text-[var(--moss)] sm:text-6xl">
            Defend It
          </p>
          <div className="seal-line mt-5 h-px w-40 bg-[var(--moss)]" />
          <h1 className="animate-rise-delay mt-8 text-3xl leading-tight text-[var(--ink)] sm:text-4xl">
            Prove you understand the work. Give receivers a score they can verify.
          </h1>
          <p className="animate-rise-delay-2 mt-5 max-w-xl text-lg text-[color-mix(in_srgb,var(--ink)_72%,transparent)]">
            LEARN privately with a Socratic coach. DEFEND in a short live interview.
            Walk away with a signed receipt bound to the exact file.
          </p>
          <div className="animate-rise-delay-2 mt-10 flex flex-wrap gap-3">
            <Link href="/request" className="btn btn-primary">
              Request a defense
            </Link>
            <Link href="/dashboard" className="btn btn-ghost">
              Receiver dashboard
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-12 grid gap-8 md:grid-cols-3">
        {[
          {
            title: "Learn",
            body: "Private explain-back, what-ifs, and planted errors. Gap map stays with the creator.",
          },
          {
            title: "Defend",
            body: "6–8 minutes grounded in the deliverable’s claims. Randomness drawn in code, not by the LLM.",
          },
          {
            title: "Receipt",
            body: "Signed score, file SHA-256, evidence excerpts, stamp with QR, public verify page.",
          },
        ].map((item) => (
          <div key={item.title} className="panel rounded-xl p-6">
            <h2 className="text-2xl text-[var(--moss)]">{item.title}</h2>
            <p className="mt-3 text-[color-mix(in_srgb,var(--ink)_70%,transparent)]">
              {item.body}
            </p>
          </div>
        ))}
      </section>
    </div>
  );
}
