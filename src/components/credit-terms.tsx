/** Shown when a defense cannot start because the account is out of credits (HTTP 402). */
export function isCreditWall(status: number): boolean {
  return status === 402;
}

export function CreditTermsNotice() {
  return (
    <p className="text-sm text-[var(--ink-2)]">
      By buying credits you agree to the{" "}
      <a href="/terms" className="text-[var(--blueprint)] underline">
        Terms
      </a>
      .
    </p>
  );
}
