import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  sha256Hex,
  signPayload,
  verifySignature,
} from "../src/lib/crypto";

describe("hashing", () => {
  it("sha256Hex is stable for the same bytes", () => {
    const a = sha256Hex("defend-it");
    const b = sha256Hex(Buffer.from("defend-it"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sha256Hex changes when content changes", () => {
    expect(sha256Hex("memo-v1")).not.toBe(sha256Hex("memo-v2"));
  });
});

describe("signing", () => {
  it("signs and verifies a receipt payload", () => {
    const payload = {
      id: "rcpt_test",
      score: 82,
      difficulty: "hard",
      deliverable: { sha256: "abc", fileName: "x.md" },
    };
    const { signature, publicKey, canonical } = signPayload(payload);
    expect(canonical).toBe(canonicalJson(payload));
    expect(verifySignature(payload, signature, publicKey)).toBe(true);
  });

  it("fails verification when payload is tampered", () => {
    const payload = { id: "rcpt_test", score: 82 };
    const { signature, publicKey } = signPayload(payload);
    expect(
      verifySignature({ id: "rcpt_test", score: 99 }, signature, publicKey),
    ).toBe(false);
  });
});
