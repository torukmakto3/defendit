import { createHmac } from "crypto";

/**
 * HMAC-SHA256 of an IP address. The key is 32 bytes, hex-encoded as
 * `IP_HASH_SALT`, or `DEMO_IP_SALT` when that name is unset. A missing or
 * malformed salt logs once and yields no hash. Callers then skip IP-keyed
 * limits and anonymous result-view counts. They do not store the address
 * and they do not store an unkeyed digest.
 */
const HEX_64 = /^[0-9a-fA-F]{64}$/;
const logged = new Set<string>();

function logSalt(detail: string): void {
  if (logged.has(detail)) return;
  logged.add(detail);
  console.error(
    `[ip-hash] ${detail} IP-keyed limits are skipped and anonymous result views are not counted. The address is not stored. Generate a salt with: openssl rand -hex 32`,
  );
}

/** Clears the once-per-process salt log. Tests use this so a later case can see the error. */
export function resetIpHashNotices(): void {
  logged.clear();
}

type SaltRead = { state: "absent" } | { state: "bad" } | { state: "ok"; value: string };

function readHex(name: string): SaltRead {
  const raw = process.env[name]?.trim() ?? "";
  if (!raw) return { state: "absent" };
  if (!HEX_64.test(raw)) {
    logSalt(`${name} must be exactly 64 hex characters (32 bytes).`);
    return { state: "bad" };
  }
  return { state: "ok", value: raw };
}

/**
 * The HMAC key, or null when neither salt is usable. A malformed
 * `IP_HASH_SALT` is ignored, so a valid `DEMO_IP_SALT` can still key the hash.
 */
export function ipHashSalt(): string | null {
  const named = readHex("IP_HASH_SALT");
  if (named.state === "ok") return named.value;
  const demo = readHex("DEMO_IP_SALT");
  if (demo.state === "ok") return demo.value;
  if (named.state === "absent" && demo.state === "absent") {
    logSalt("IP_HASH_SALT is not set.");
  }
  return null;
}

/** Log at startup when no usable salt is configured. Never throws. */
export function assertIpHashConfigured(): void {
  ipHashSalt();
}

/** Keyed hash, or null when there is no usable salt. The same address and salt always return the same hex. */
export function ipHash(ip: string): string | null {
  const salt = ipHashSalt();
  if (!salt) return null;
  return createHmac("sha256", Buffer.from(salt, "hex")).update(ip).digest("hex");
}
