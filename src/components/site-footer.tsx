/** Shown on every page from the root layout. */
export function SiteFooter() {
  return (
    <footer className="border-t-[1.5px] border-[var(--ink)] bg-[var(--card)]">
      <div className="shell flex flex-wrap items-center justify-between gap-3 py-4 text-sm text-[var(--ink-2)]">
        <p>Defend It</p>
        <nav aria-label="Site" className="flex flex-wrap gap-x-4 gap-y-2">
          <a href="/terms" className="hover:text-[var(--blueprint)]">
            Terms
          </a>
          <a href="/privacy" className="hover:text-[var(--blueprint)]">
            Privacy
          </a>
          <a href="/how-it-works" className="hover:text-[var(--blueprint)]">
            How it works
          </a>
          <a href="/faq" className="hover:text-[var(--blueprint)]">
            FAQ
          </a>
          <a href="/founding" className="hover:text-[var(--blueprint)]">
            Founding
          </a>
        </nav>
      </div>
    </footer>
  );
}
