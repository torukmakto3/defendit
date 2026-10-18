import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { load32ByteSecret } from "./secrets";

/**
 * Field-level encryption at rest (AES-256-GCM) for anything derived from a
 * deliverable: extracted text, claims, transcripts, grades, file names.
 *
 * Format: v1.<iv>.<tag>.<ciphertext>, base64url. The `context` (table.column:id)
 * is bound as additional authenticated data, so a ciphertext copied into
 * another row or column fails to decrypt. Purging a field = setting it NULL.
 */
const VERSION = "v1";
let cachedKey: Buffer | null = null;

function dataKey(): Buffer {
  if (!cachedKey) {
    cachedKey = load32ByteSecret("DATA_ENCRYPTION_KEY", "data-key.json");
  }
  return cachedKey;
}

export function encryptField(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptField(
  value: string | null | undefined,
  context: string,
): string | null {
  if (value == null) return null;
  const [version, iv, tag, ct] = value.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) {
    throw new Error("Unrecognised ciphertext format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptJson(value: unknown, context: string): string {
  return encryptField(JSON.stringify(value), context);
}

export function decryptJson<T>(
  value: string | null | undefined,
  context: string,
): T | null {
  const text = decryptField(value, context);
  return text == null ? null : (JSON.parse(text) as T);
}

export function resetVaultForTests() {
  cachedKey = null;
}
