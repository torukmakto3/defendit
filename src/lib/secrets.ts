import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** Running as a real deployment (not `npm run dev` / tests). Not overridable. */
export function isDeployed(): boolean {
  return process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
}

/** Whether secrets must come from env. DEFEND_IT_REQUIRE_KEYS overrides for local `npm start`. */
export function keysRequired(): boolean {
  if (process.env.DEFEND_IT_REQUIRE_KEYS === "1") return true;
  if (process.env.DEFEND_IT_REQUIRE_KEYS === "0") return false;
  return isDeployed();
}

/**
 * A 32-byte secret as 64 hex chars. Deployed instances must take it from the
 * environment; local dev auto-generates it into ./data (gitignored).
 */
export function load32ByteSecret(envName: string, devFile: string): Buffer {
  const fromEnv = process.env[envName];
  if (fromEnv) {
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error(`${envName} must be exactly 64 hex characters (32 bytes).`);
    }
    return Buffer.from(fromEnv, "hex");
  }
  if (keysRequired()) {
    throw new Error(
      `${envName} is not set. Generate one with: openssl rand -hex 32`,
    );
  }
  // Dev keys + a shared database would write rows the deployment can't
  // decrypt or verify (e.g. after `vercel env pull` puts DATABASE_URL in .env.local).
  if (process.env.DATABASE_URL) {
    throw new Error(
      `${envName} is not set but DATABASE_URL is: refusing to use local dev keys against a shared database. ` +
        "Unset DATABASE_URL for local dev, or set the deployment's keys.",
    );
  }
  const path = join(process.cwd(), "data", devFile);
  if (existsSync(path)) {
    const hex = (JSON.parse(readFileSync(path, "utf8")) as { hex: string }).hex;
    return Buffer.from(hex, "hex");
  }
  const secret = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hex: secret.toString("hex") }), {
    mode: 0o600,
  });
  return secret;
}
