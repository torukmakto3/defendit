/** Shown when a defense cannot start because the account is out of credits (HTTP 402). */
export function isCreditWall(status: number): boolean {
  return status === 402;
}

export function CreditTermsNotice() {
  return (
    <p className="text-sm text-[var(--ink-2)]">
      Credits are covered by our{" "}
      <a href="/terms" className="text-[var(--blueprint)] underline">
        Terms
      </a>
      .
    </p>
  );
}
