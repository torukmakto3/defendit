import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 16);
const short = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${nano()}` : nano();
}

export function newToken(): string {
  return short();
}
