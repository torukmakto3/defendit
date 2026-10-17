import { createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// Sync ed25519 APIs require an explicit sha512 (Node/vitest CJS path).
ed.hashes.sha512 = (...msgs: Uint8Array[]) => sha512(ed.etc.concatBytes(...msgs));

const KEY_PATH = join(process.cwd(), "data", "signing-key.json");

export function sha256Hex(data: Buffer | string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys(obj[key]);
    }
    return out;
  }
  return value;
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

function loadOrCreateKeys(): KeyMaterial {
  const seedEnv = process.env.DEFEND_IT_SIGNING_SEED;
  if (seedEnv) {
    const secretKey = hexToBytes(seedEnv.padEnd(64, "0").slice(0, 64));
    const publicKey = ed.getPublicKey(secretKey);
    return {
      secretKeyHex: bytesToHex(secretKey),
      publicKeyHex: bytesToHex(publicKey),
    };
  }

  if (existsSync(KEY_PATH)) {
    return JSON.parse(readFileSync(KEY_PATH, "utf8")) as KeyMaterial;
  }

  const secretKey = randomBytes(32);
  const publicKey = ed.getPublicKey(secretKey);
  const material: KeyMaterial = {
    secretKeyHex: bytesToHex(secretKey),
    publicKeyHex: bytesToHex(publicKey),
  };
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, JSON.stringify(material, null, 2));
  return material;
}

export function getPublicKeyHex(): string {
  return loadOrCreateKeys().publicKeyHex;
}

export function signPayload(payload: unknown): {
  signature: string;
  publicKey: string;
  canonical: string;
} {
  const keys = loadOrCreateKeys();
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
