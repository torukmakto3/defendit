import { afterEach, describe, expect, it } from "vitest";
import { decryptField, encryptField, resetVaultForTests } from "../src/lib/vault";

const KEY = "11".repeat(32);

afterEach(() => {
  delete process.env.DATA_ENCRYPTION_KEY;
  delete process.env.DEFEND_IT_REQUIRE_KEYS;
  resetVaultForTests();
});

describe("vault", () => {
  it("round-trips text bound to its record context", () => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    const ct = encryptField("confidential memo body", "deliverables.text:del_1");
    expect(ct).not.toContain("confidential");
    expect(ct.startsWith("v1.")).toBe(true);
    expect(decryptField(ct, "deliverables.text:del_1")).toBe(
      "confidential memo body",
    );
  });

  it("uses a fresh IV per encryption", () => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    expect(encryptField("same", "ctx")).not.toBe(encryptField("same", "ctx"));
  });

  it("refuses a ciphertext moved to another record", () => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    const ct = encryptField("secret", "deliverables.text:del_1");
    expect(() => decryptField(ct, "deliverables.text:del_2")).toThrow();
  });

  it("refuses a tampered ciphertext", () => {
    process.env.DATA_ENCRYPTION_KEY = KEY;
    const ct = encryptField("secret", "ctx");
    const parts = ct.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptField(parts.join("."), "ctx")).toThrow();
  });

  it("returns null for purged (null) fields", () => {
    expect(decryptField(null, "ctx")).toBeNull();
  });

  it("requires a configured key when keys are mandatory", () => {
    process.env.DEFEND_IT_REQUIRE_KEYS = "1";
    expect(() => encryptField("x", "ctx")).toThrow(/DATA_ENCRYPTION_KEY/);
  });

  it("rejects a malformed key", () => {
    process.env.DATA_ENCRYPTION_KEY = "abc";
    expect(() => encryptField("x", "ctx")).toThrow(/64 hex/);
  });
});
