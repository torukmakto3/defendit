/**
 * Sample-demo policy. No database and no file reads, so client components
 * can import the notice without pulling in the server.
 */

export const DEMO_COOKIE = "di_demo";

/** One day, for the per-IP and global demo counters. */
export const DEMO_WINDOW_SEC = 24 * 60 * 60;

export const DEMO_EMAIL_DOMAIN = "demo.defendit.invalid";

export const DEMO_NOTICE = "Demo on a sample file. Not a credential.";

export const DEMO_COPY = {
  disabled: "The sample demo is turned off right now. Sign in to defend your own file.",
  ip: "You've used today's free sample defenses on this network. Sign in to defend your own file, or try again tomorrow.",
  global: "The sample demo is full for today. Try again tomorrow, or sign in to defend your own file.",
  budget: "The beta is full today, so the sample demo is paused. Sign in if you already have an account.",
  noLearn: "This sample is only a short defense. Sign in to use Learn, challenges, or your own file.",
  noUpload: "This sample file can't be replaced. Sign in to defend your own file.",
  openFromHome: "Open the sample from the homepage. This demo is not an account.",
  cta: "Sign in and defend your own file (3 free).",
} as const;

export const DEMO_SAMPLES = {
  "harbor-readme": { file: "harbor-readme.md", title: "Harbor README" },
  "lane-memo": { file: "lane-memo.md", title: "Lane design memo" },
} as const;

export type DemoSampleId = keyof typeof DEMO_SAMPLES;

export function isDemoSampleId(value: string): value is DemoSampleId {
  return Object.prototype.hasOwnProperty.call(DEMO_SAMPLES, value);
}

/** Kill switch. Unset means on. `0` or `false` turns the sample path off. */
export function demoEnabled(): boolean {
  const raw = process.env.DEMO_ENABLED;
  if (raw == null || raw.trim() === "") return true;
  return raw === "1" || raw === "true";
}

export function demoPerIpPerDay(): number {
  return envInt("DEMO_PER_IP_PER_DAY", 3);
}

export function demoDailyCap(): number {
  return envInt("DEMO_DAILY_CAP", 200);
}

/** How long a sample defense, its answers, and its receipt stay. Default 24 hours. */
export function demoRetentionHours(): number {
  const hours = envInt("DEMO_RETENTION_HOURS", 24);
  return hours > 0 ? hours : 24;
}

export function isDemoPrincipalEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

export function isDemoKind(kind: string): boolean {
  return kind === "demo";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return fallback;
  return n;
}
