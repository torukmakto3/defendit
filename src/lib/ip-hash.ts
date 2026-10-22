import { createHmac } from "crypto";

/**
 * HMAC-SHA256 of an IP address. The key is 32 bytes, hex-encoded as
 * `IP_HASH_SALT`, or `DEMO_IP_SALT` when that one is unset. Production
 * refuses to start or hash without one of those. Dev and tests use a fixed
 * key so a missing salt is not a silent unkeyed digest.
 */
const DEV_IP_HASH_SALT = "00".repeat(32);
const HEX_64 = /^[0-9a-fA-F]{64}$/;

function saltError(name: string, detail: string): Error {
  return new Error(
    `${name} ${detail} IP addresses are keyed with HMAC-SHA256. Generate a salt with: openssl rand -hex 32`,
  );
}

/** The HMAC key, or a thrown error when production has none. */
export function ipHashSalt(): string {
  const named = process.env.IP_HASH_SALT?.trim();
  if (named) {
    if (!HEX_64.test(named)) {
      throw saltError("IP_HASH_SALT", "must be exactly 64 hex characters (32 bytes).");
    }
    return named;
  }
  const demo = process.env.DEMO_IP_SALT?.trim();
  if (demo) {
    if (!HEX_64.test(demo)) {
      throw saltError("DEMO_IP_SALT", "must be exactly 64 hex characters (32 bytes).");
    }
    return demo;
  }
  if (process.env.NODE_ENV === "production") {
    throw saltError("IP_HASH_SALT", "is not set.");
  }
  return DEV_IP_HASH_SALT;
}

/** Fail at startup when production has no salt. Dev keeps the fixed key. */
export function assertIpHashConfigured(): void {
  ipHashSalt();
}

/** Keyed hash of an address. The same address and salt always return the same hex. */
export function ipHash(ip: string): string {
  const key = Buffer.from(ipHashSalt(), "hex");
  return createHmac("sha256", key).update(ip).digest("hex");
}
