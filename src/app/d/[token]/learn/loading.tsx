import { Companion } from "@/components/companion/Companion";

/** Shown while the Learn route loads, before the flashcard stream starts. */
export default function LearnLoading() {
  return (
    <div className="shell grid max-w-2xl gap-6">
      <div>
        <span className="eyebrow">Learn · private</span>
        <h1 className="text-3xl font-bold">Your file</h1>
      </div>
      <div className="panel grid gap-4 p-5 sm:p-6" aria-busy="true">
        <div className="grid grid-cols-[auto_1fr] items-start gap-4">
          <Companion state="thinking" size={64} />
          <div className="grid min-w-0 gap-2">
            <span className="mono text-xs uppercase tracking-[0.08em] text-[var(--blueprint)]">Question</span>
            <span className="block h-5 w-4/5 animate-pulse bg-[var(--line)]" />
            <span className="block h-5 w-2/3 animate-pulse bg-[var(--line)]" />
          </div>
        </div>
        <p className="text-sm text-[var(--ink-2)]">Writing the first card…</p>
      </div>
    </div>
  );
}
