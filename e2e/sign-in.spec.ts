import { expect, test, type Page } from "@playwright/test";

const PAGES = [
  { path: "/", title: "Sign in to drop a deliverable" },
  { path: "/dashboard", title: "Sign in to see your dashboard" },
  { path: "/request", title: "Sign in to request a defense" },
  { path: "/learn", title: "Sign in to see your projects" },
  { path: "/learn/review", title: "Sign in to review your cards" },
];

function card(page: Page, title: string) {
  return page.locator(".panel").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

async function offer(page: Page, methods: { google: boolean; email: boolean }) {
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(methods),
    }),
  );
}

test("hides email sign-in on every card when the server says email is off", async ({ page }) => {
  await offer(page, { google: true, email: false });
  for (const entry of PAGES) {
    await page.goto(entry.path);
    const panel = card(page, entry.title);
    await expect(panel.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
    await expect(panel.getByLabel("Email")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Email me a link" })).toHaveCount(0);
    await expect(panel.getByText("or", { exact: true })).toHaveCount(0);
    await expect(panel.getByText(/aren.t set up/)).toHaveCount(0);
    await expect(panel.getByText(/isn.t set up/)).toHaveCount(0);
    await expect(panel.getByText("Sign-in isn't available")).toHaveCount(0);
  }
});

test("keeps the email form when the server says email is on", async ({ page }) => {
  await offer(page, { google: true, email: true });
  await page.goto("/");
  const panel = card(page, "Sign in to drop a deliverable");
  await expect(panel.getByRole("link", { name: "Sign in with Google" })).toBeVisible();
  await expect(panel.getByLabel("Email")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Email me a link" })).toBeVisible();
  await expect(panel.getByText("or", { exact: true })).toBeVisible();
  await expect(panel.getByText(/aren.t set up/)).toHaveCount(0);
});

test("keeps the unavailable fallback when Google and email are both off", async ({ page }) => {
  await offer(page, { google: false, email: false });
  await page.goto("/");
  const panel = card(page, "Sign in to drop a deliverable");
  await expect(
    panel.getByText(
      "Sign-in isn't available on this server yet. Google sign-in and email links are both turned off.",
    ),
  ).toBeVisible();
  await expect(panel.getByRole("link", { name: "Sign in with Google" })).toHaveCount(0);
  await expect(panel.getByLabel("Email")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Email me a link" })).toHaveCount(0);
});
