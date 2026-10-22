import type { ReactNode } from "react";
import { LEGAL_UPDATED } from "@/lib/operator";

export function LegalPage({
  eyebrow,
  title,
  lede,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="shell">
      <div className="grid max-w-3xl gap-8">
        <header className="grid gap-3">
          <p className="eyebrow">{eyebrow}</p>
          <h1 className="text-3xl font-bold sm:text-4xl">{title}</h1>
          <p className="text-sm text-[var(--ink-2)]">Last updated {LEGAL_UPDATED}</p>
          <div className="grid gap-3 text-[var(--ink-2)]">{lede}</div>
        </header>
        {children}
      </div>
    </article>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel grid gap-3 p-5 sm:p-6">
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="grid gap-3 text-[var(--ink-2)]">{children}</div>
    </section>
  );
}
