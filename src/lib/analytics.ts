/**
 * First-party funnel events. `track()` lives in `analytics-store.ts` so this
 * module stays free of the database and can be type-imported from the client.
 *
 * Challenge events no-op unless `CHALLENGES_ENABLED` is `1` or `true`.
 * Call `trackChallenge` at `CHALLENGE_TRACK_SITES` in `src/lib/challenges.ts`.
 */

export const ANALYTICS_EVENTS = [
  "landing_view",
  "sign_in_started",
  "sign_in_completed",
  "defense_started",
  "defense_completed",
  "receipt_shared",
  "learn_opened",
  "challenge_created",
  "challenge_opened",
  "challenge_accepted",
  "challenge_declined",
  "challenge_completed",
  "challenge_shared_back",
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export const CHALLENGE_EVENTS = [
  "challenge_created",
  "challenge_opened",
  "challenge_accepted",
  "challenge_declined",
  "challenge_completed",
  "challenge_shared_back",
] as const;

export type ChallengeEventName = (typeof CHALLENGE_EVENTS)[number];

/** Events a browser beacon may send. Everything else is recorded on the server. */
export const CLIENT_ANALYTICS_EVENTS = ["landing_view", "receipt_shared"] as const;

export type ClientAnalyticsEvent = (typeof CLIENT_ANALYTICS_EVENTS)[number];

export const ANALYTICS_RETENTION_DAYS = 90;
export const FUNNEL_DAYS = 7;

const TIERS = ["standard", "hard", "expert"] as const;
const SIGN_IN_METHODS = ["email", "google"] as const;
const SHARE_METHODS = ["share", "copy"] as const;
const CHALLENGE_KINDS = ["self", "third_party"] as const;
const ONWARD_SOURCES = ["defender", "viewer"] as const;
const SPONSORS = ["beta", "paid"] as const;

const UTM_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function isAnalyticsEvent(name: string): name is AnalyticsEventName {
  return (ANALYTICS_EVENTS as readonly string[]).includes(name);
}

export function isChallengeEvent(name: string): name is ChallengeEventName {
  return (CHALLENGE_EVENTS as readonly string[]).includes(name);
}

export function isClientAnalyticsEvent(name: string): name is ClientAnalyticsEvent {
  return (CLIENT_ANALYTICS_EVENTS as readonly string[]).includes(name);
}

/** On unless explicitly disabled. `false` and `0` turn recording off. */
export function analyticsEnabled(value = process.env.ANALYTICS_ENABLED): boolean {
  if (value == null) return true;
  const flag = value.trim().toLowerCase();
  if (flag === "") return true;
  return flag !== "false" && flag !== "0" && flag !== "off" && flag !== "no";
}

/** Matches `challengesEnabled()` on the challenge-links branch. Default off. */
export function challengesAnalyticsEnabled(value = process.env.CHALLENGES_ENABLED): boolean {
  return value === "1" || value === "true";
}

export function trackingOptOut(headers: { get(name: string): string | null }): boolean {
  if (headers.get("dnt") === "1") return true;
  if (headers.get("sec-gpc") === "1") return true;
  return false;
}

export function minuteStamp(date: Date): string {
  const d = new Date(date.getTime());
  if (Number.isNaN(d.getTime())) {
    const fallback = new Date();
    fallback.setUTCSeconds(0, 0);
    return fallback.toISOString();
  }
  d.setUTCSeconds(0, 0);
  return d.toISOString();
}

export function analyticsRetentionCutoff(now = new Date()): string {
  return new Date(now.getTime() - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Hostname only. Full URLs, paths, and IP addresses are dropped. */
export function referrerDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!host || host.length > 253 || isIpHost(host)) return null;
  return host;
}

function isIpHost(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  return hostname.includes(":");
}

function oneOf(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  return allowed.includes(value) ? value : null;
}

function utmValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!UTM_VALUE.test(trimmed)) return null;
  return trimmed;
}

function propSource(props: unknown): Record<string, unknown> {
  if (!props || typeof props !== "object" || Array.isArray(props)) return {};
  return props as Record<string, unknown>;
}

/** Keep a small whitelist. Emails, scores, document text, and unknown keys are dropped. */
export function sanitizeProps(name: AnalyticsEventName, props: unknown): Record<string, string> {
  const source = propSource(props);
  const out: Record<string, string> = {};
  switch (name) {
    case "landing_view": {
      const sourceValue = utmValue(source.utm_source);
      const campaign = utmValue(source.utm_campaign);
      if (sourceValue) out.utm_source = sourceValue;
      if (campaign) out.utm_campaign = campaign;
      break;
    }
    case "sign_in_started":
    case "sign_in_completed": {
      const method = oneOf(source.method, SIGN_IN_METHODS);
      if (method) out.method = method;
      break;
    }
    case "defense_started":
    case "defense_completed":
    case "challenge_completed": {
      const tier = oneOf(source.tier, TIERS);
      if (tier) out.tier = tier;
      break;
    }
    case "receipt_shared":
    case "challenge_shared_back": {
      const method = oneOf(source.method, SHARE_METHODS);
      if (method) out.method = method;
      break;
    }
    case "challenge_created": {
      const kind = oneOf(source.kind, CHALLENGE_KINDS);
      const onward = oneOf(source.onward, ONWARD_SOURCES);
      const sponsor = oneOf(source.sponsor, SPONSORS);
      if (kind) out.kind = kind;
      if (onward) out.onward = onward;
      if (sponsor) out.sponsor = sponsor;
      break;
    }
    case "learn_opened":
    case "challenge_opened":
    case "challenge_accepted":
    case "challenge_declined":
      break;
    default: {
      const unknown: never = name;
      void unknown;
      break;
    }
  }
  return out;
}

export interface TrackInput {
  name: AnalyticsEventName;
  /** Full referrer URL. Only the domain is stored. */
  referrer?: string | null;
  props?: unknown;
  /** When present, DNT and Sec-GPC skip the event. */
  headers?: { get(name: string): string | null };
  now?: Date;
}

export interface AnalyticsRow {
  name: AnalyticsEventName;
  occurredAt: string;
  referrerDomain: string | null;
  props: Record<string, string>;
}

export function prepareTrack(input: TrackInput): { ok: true; row: AnalyticsRow } | { ok: false } {
  if (!analyticsEnabled()) return { ok: false };
  if (!isAnalyticsEvent(input.name)) return { ok: false };
  if (isChallengeEvent(input.name) && !challengesAnalyticsEnabled()) return { ok: false };
  if (input.headers && trackingOptOut(input.headers)) return { ok: false };
  return {
    ok: true,
    row: {
      name: input.name,
      occurredAt: minuteStamp(input.now ?? new Date()),
      referrerDomain: referrerDomain(input.referrer),
      props: sanitizeProps(input.name, input.props),
    },
  };
}

export interface FunnelStep {
  event: AnalyticsEventName;
  label: string;
  count: number;
  /** Share of the previous step. Null for the first step, or when the previous count is 0. */
  conversion: number | null;
}

export interface FunnelReport {
  days: number;
  since: string;
  product: FunnelStep[];
  challenge: FunnelStep[];
  /** Declines sit beside the chain. The rate is declined ÷ opened, not declined ÷ accepted. */
  declined: { count: number; conversion: number | null };
  /** New challenges from a defender or a viewer of a shared card, ÷ completions. */
  onwardK: number | null;
  onwardCount: number;
  selfChallenges: number;
  thirdPartyChallenges: number;
  unspecifiedChallenges: number;
}

const PRODUCT_STEPS: readonly { event: AnalyticsEventName; label: string }[] = [
  { event: "landing_view", label: "Landing view" },
  { event: "sign_in_started", label: "Sign-in started" },
  { event: "sign_in_completed", label: "Sign-in completed" },
  { event: "defense_started", label: "Defense started" },
  { event: "defense_completed", label: "Defense completed" },
  { event: "receipt_shared", label: "Receipt shared" },
];

const CHALLENGE_STEPS: readonly { event: AnalyticsEventName; label: string }[] = [
  { event: "challenge_created", label: "Issued" },
  { event: "challenge_opened", label: "Opened by defender" },
  { event: "challenge_accepted", label: "Accepted" },
  { event: "challenge_completed", label: "Completed" },
  { event: "challenge_shared_back", label: "Shared back" },
];

export function conversionRate(count: number, base: number): number | null {
  if (!Number.isFinite(base) || base <= 0) return null;
  if (!Number.isFinite(count) || count < 0) return null;
  return count / base;
}

export function buildFunnel(input: {
  counts: Partial<Record<AnalyticsEventName, number>>;
  created: { kind?: string; onward?: string }[];
  since: string;
  days?: number;
}): FunnelReport {
  const countOf = (name: AnalyticsEventName) => {
    const n = input.counts[name] ?? 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const chain = (steps: readonly { event: AnalyticsEventName; label: string }[]): FunnelStep[] =>
    steps.map((step, index) => {
      const count = countOf(step.event);
      const previous = index === 0 ? 0 : countOf(steps[index - 1].event);
      return {
        event: step.event,
        label: step.label,
        count,
        conversion: index === 0 ? null : conversionRate(count, previous),
      };
    });

  let selfChallenges = 0;
  let thirdPartyChallenges = 0;
  let unspecifiedChallenges = 0;
  let onwardCount = 0;
  for (const row of input.created) {
    if (row.kind === "self") selfChallenges += 1;
    else if (row.kind === "third_party") thirdPartyChallenges += 1;
    else unspecifiedChallenges += 1;
    if (row.onward === "defender" || row.onward === "viewer") onwardCount += 1;
  }

  const opened = countOf("challenge_opened");
  const completed = countOf("challenge_completed");
  return {
    days: input.days ?? FUNNEL_DAYS,
    since: input.since,
    product: chain(PRODUCT_STEPS),
    challenge: chain(CHALLENGE_STEPS),
    declined: {
      count: countOf("challenge_declined"),
      conversion: conversionRate(countOf("challenge_declined"), opened),
    },
    onwardK: conversionRate(onwardCount, completed),
    onwardCount,
    selfChallenges,
    thirdPartyChallenges,
    unspecifiedChallenges,
  };
}

/**
 * Where `src/lib/challenges.ts` should call `trackChallenge`. Count the event
 * only. Do not pass an account id, session id, receipt id, or challenge id.
 */
export const CHALLENGE_TRACK_SITES = [
  {
    event: "challenge_created",
    file: "src/lib/challenges.ts",
    symbol: "createChallenge",
    when:
      "After the insert transaction commits, beside recordEvent(..., \"created\"). Once per created challenge, not when create is rejected.",
    props:
      "kind \"self\" when the creator is challenging their own work, otherwise \"third_party\". onward \"defender\" for /c/new?onward=defender (the receipt pass-it-on link) and \"viewer\" for /c/new?onward=viewer (a shared card). sponsor \"beta\" or \"paid\". Omit onward when neither.",
  },
  {
    event: "challenge_opened",
    file: "src/lib/challenges.ts",
    symbol: "getPublicChallenge",
    when:
      "When opts.recordView is true and the viewer is not the creator (user?.id !== row.creator_user_id). src/app/c/[slug]/page.tsx already passes recordView: true. Skip the creator's own loads so acceptance stays accepted ÷ defender opens.",
    props: "none",
  },
  {
    event: "challenge_accepted",
    file: "src/lib/challenges.ts",
    symbol: "claimChallenge",
    when: "After the claim transaction commits, beside recordEvent(..., \"accepted\").",
    props: "none",
  },
  {
    event: "challenge_declined",
    file: "src/lib/challenges.ts",
    symbol: "declineChallenge",
    when:
      "Only when declineChallenge returns { closed: true }. Do not track the hide path (closed: false); that leaves the challenge open and stays invisible.",
    props: "none",
  },
  {
    event: "challenge_completed",
    file: "src/lib/challenges.ts",
    symbol: "noteChallengeDefended",
    when:
      "When row.status was \"claimed\" and the defense is stored, beside recordEvent(..., \"defended\"). Skip the retry that finds status already \"defended\".",
    props: "tier is the challenge difficulty (standard, hard, or expert). Never the score or Strong / Defended / Still sharpening.",
  },
  {
    event: "challenge_shared_back",
    file: "src/lib/challenges.ts",
    symbol: "recordShareClick",
    when:
      "Only when the challenge status is \"defended\" (ShareBar on the receipt and PublicResult). Do not count ShareBar on an open /c/{slug} link. Map channel \"x\" to method \"share\" and \"copy\" to \"copy\".",
    props: "method \"share\" or \"copy\"",
  },
] as const;
