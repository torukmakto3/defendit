import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);
// 22 chars over 62 symbols ≈ 131 bits: safe for bearer links and public receipt ids.
const secret = customAlphabet(
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  22,
);

export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${nano()}` : nano();
}

/** Unguessable id for anything reachable by URL alone (defense links, receipts). */
export function newToken(): string {
  return secret();
}

export function newReceiptId(): string {
  return `rcpt_${secret()}`;
}
