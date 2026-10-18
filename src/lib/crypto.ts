import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "./canonical";
import { load32ByteSecret } from "./secrets";

export { canonicalJson };

// Sync ed25519 APIs require an explicit sha512 (Node/vitest CJS path).
ed.hashes.sha512 = (...msgs: Uint8Array[]) => sha512(ed.etc.concatBytes(...msgs));

export function sha256Hex(data: Buffer | string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

interface KeyMaterial {
  secretKeyHex: string;
  publicKeyHex: string;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

let cachedKeys: KeyMaterial | null = null;

/** Receipt signing key: DEFEND_IT_SIGNING_SEED in deployments, a dev file locally. */
function loadKeys(): KeyMaterial {
  if (cachedKeys) return cachedKeys;
  const secretKey = new Uint8Array(
    load32ByteSecret("DEFEND_IT_SIGNING_SEED", "signing-seed.json"),
  );
  cachedKeys = {
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(ed.getPublicKey(secretKey)),
  };
  return cachedKeys;
}

export function getPublicKeyHex(): string {
  return loadKeys().publicKeyHex;
}

export function signPayload(payload: unknown): {
  signature: string;
  publicKey: string;
  canonical: string;
} {
  const keys = loadKeys();
  const canonical = canonicalJson(payload);
  const message = new TextEncoder().encode(canonical);
  const signature = ed.sign(message, hexToBytes(keys.secretKeyHex));
  return {
    signature: bytesToHex(signature),
    publicKey: keys.publicKeyHex,
    canonical,
  };
}

export function verifySignature(
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  try {
    const canonical = canonicalJson(payload);
    const message = new TextEncoder().encode(canonical);
    return ed.verify(
      hexToBytes(signatureHex),
      message,
      hexToBytes(publicKeyHex),
    );
  } catch {
    return false;
  }
}
