/** Shown on every page from the root layout. */
export function SiteFooter() {
  return (
    <footer className="border-t-[1.5px] border-[var(--ink)] bg-[var(--card)]">
      <div className="shell flex flex-wrap items-center justify-between gap-3 py-4 text-sm text-[var(--ink-2)]">
        <p>Defend It</p>
        <a href="/privacy" className="hover:text-[var(--blueprint)]">
          Privacy
        </a>
      </div>
    </footer>
  );
}
