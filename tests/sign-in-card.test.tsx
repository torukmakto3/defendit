import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignInChoices } from "../src/components/auth";

const UNAVAILABLE =
  "Sign-in isn&#x27;t available on this server yet. Google sign-in and email links are both turned off.";

function html(options: { google: boolean; email: boolean }, next?: string): string {
  return renderToStaticMarkup(
    createElement(SignInChoices, { options, title: "Sign in to continue", next }),
  );
}

describe("sign-in card", () => {
  it("shows only Google when email links are not offered", () => {
    const card = html({ google: true, email: false }, "/dashboard");
    expect(card).toContain("Sign in with Google");
    expect(card).toContain('href="/api/auth/google?next=%2Fdashboard"');
    expect(card).toContain("Sign in with the Google account");
    expect(card).not.toContain("signin-email");
    expect(card).not.toContain("Email me a link");
    expect(card).not.toContain("aren't set up");
    expect(card).not.toContain("aren&#x27;t set up");
    expect(card).not.toContain("tracking-[0.08em]");
    expect(card).not.toContain(UNAVAILABLE);
    expect(card).not.toContain("RESEND_API_KEY");
    expect(card).not.toContain("EMAIL_FROM");
  });

  it("keeps Google and the email form when email links are offered", () => {
    const card = html({ google: true, email: true });
    expect(card).toContain("Sign in with Google");
    expect(card).toContain('href="/api/auth/google"');
    expect(card).toContain("one-time email link");
    expect(card).toContain('id="signin-email"');
    expect(card).toContain("Email me a link");
    expect(card).toContain("btn btn-ghost");
    expect(card).toContain("tracking-[0.08em]");
    expect(card).toContain(">or<");
    expect(card).not.toContain("aren't set up");
    expect(card).not.toContain("aren&#x27;t set up");
  });

  it("keeps the email form on its own when Google is not configured", () => {
    const card = html({ google: false, email: true });
    expect(card).not.toContain("Sign in with Google");
    expect(card).toContain("We email you a one-time link");
    expect(card).toContain('id="signin-email"');
    expect(card).toContain("Email me a link");
    expect(card).toContain("btn btn-primary");
    expect(card).not.toContain("tracking-[0.08em]");
    expect(card).not.toContain("aren't set up");
  });

  it("keeps the unavailable fallback when neither method is configured", () => {
    const card = html({ google: false, email: false });
    expect(card).toContain(UNAVAILABLE);
    expect(card).not.toContain("Sign in with Google");
    expect(card).not.toContain("signin-email");
    expect(card).not.toContain("Email me a link");
    expect(card).not.toContain("tracking-[0.08em]");
  });
});
