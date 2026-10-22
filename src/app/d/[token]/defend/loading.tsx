import { Companion } from "@/components/companion/Companion";

/** Shown while the interview route loads, before the first question is ready. */
export default function DefendLoading() {
  return (
    <div className="shell grid max-w-3xl gap-4">
      <div>
        <p className="eyebrow">Defend · text interview</p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Live defense</h1>
      </div>
      <div className="panel grid gap-4 p-5 sm:p-6" aria-busy="true">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state="thinking" size={64} />
          <div className="grid min-w-0 gap-2">
            <p className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Question</p>
            <span className="block h-5 w-4/5 animate-pulse bg-[var(--line)]" />
            <span className="block h-5 w-2/3 animate-pulse bg-[var(--line)]" />
          </div>
        </div>
        <p className="text-sm text-[var(--ink-2)]">Writing the first question…</p>
      </div>
    </div>
  );
}
