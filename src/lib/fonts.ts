import { readFileSync } from "fs";
import { join } from "path";

/** Server-side font files for the receipt PDF and stamp PNG (see assets/fonts). */
export const FONT_FILES = {
  mono: "JetBrainsMono_400Regular.ttf",
  monoBold: "JetBrainsMono_700Bold.ttf",
  body: "PublicSans_400Regular.ttf",
  bodyBold: "PublicSans_600SemiBold.ttf",
  display: "Sora_700Bold.ttf",
} as const;

export function fontPath(name: keyof typeof FONT_FILES): string {
  return join(/*turbopackIgnore: true*/ process.cwd(), "assets", "fonts", FONT_FILES[name]);
}

const cache = new Map<string, Buffer>();
export function fontBytes(name: keyof typeof FONT_FILES): Buffer {
  const path = fontPath(name);
  let bytes = cache.get(path);
  if (!bytes) {
    bytes = readFileSync(/*turbopackIgnore: true*/ path);
    cache.set(path, bytes);
  }
  return bytes;
}
