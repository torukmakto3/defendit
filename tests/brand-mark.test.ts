import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBrandIcons } from "../scripts/brand-icon";

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url));
}

function pngHeader(buf: Buffer) {
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(buf.subarray(12, 16).toString()).toBe("IHDR");
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

function icoFrames(buf: Buffer) {
  expect(buf.readUInt16LE(0)).toBe(0);
  expect(buf.readUInt16LE(2)).toBe(1);
  const count = buf.readUInt16LE(4);
  const frames: { width: number; height: number; png: boolean }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = buf.readUInt32LE(at + 8);
    const offset = buf.readUInt32LE(at + 12);
    frames.push({
      width: buf[at] || 256,
      height: buf[at + 1] || 256,
      png: buf.subarray(offset, offset + size).subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
    });
  }
  return frames;
}

function dayToken(name: string): string {
  const css = read("src/app/globals.css").toString("utf8");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("@media"));
  const match = root.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  expect(match, name).toBeTruthy();
  return match![1].toLowerCase();
}

describe("brand mark", () => {
  it("keeps the revision label out of the header", () => {
    const layout = read("src/app/layout.tsx").toString("utf8");
    expect(layout).toContain("Defend It");
    expect(layout).not.toMatch(/rev\s*b/i);
  });

  it("ships a path D in the day card colour on an ink tile", () => {
    const ink = dayToken("ink");
    // Pressed theme toggle: light text on ink is --card, not blueprint.
    const onInk = dayToken("card");
    const svg = read("src/app/icon.svg").toString("utf8");
    expect(svg).toContain(`fill="${ink}"`);
    expect(svg).toContain(`fill="${onInk}"`);
    expect(svg).not.toContain(`fill="${dayToken("blueprint")}"`);
    expect(svg).toContain("<path");
    expect(svg).not.toContain("<text");
    expect(svg).not.toMatch(/set-square|M21 43/i);

    const frames = icoFrames(read("src/app/favicon.ico"));
    expect(frames.map((frame) => frame.width)).toEqual([16, 32, 48]);
    expect(frames.every((frame) => frame.png && frame.width === frame.height)).toBe(true);

    const icon = pngHeader(read("src/app/icon.png"));
    expect(icon).toMatchObject({ width: 512, height: 512, bitDepth: 8 });

    const apple = pngHeader(read("src/app/apple-icon.png"));
    // Color type 2 is truecolor with no alpha channel, so the home-screen tile stays opaque.
    expect(apple).toMatchObject({ width: 180, height: 180, bitDepth: 8, colorType: 2 });

    const rendered = renderBrandIcons(svg);
    expect(rendered.iconPng.equals(read("src/app/icon.png"))).toBe(true);
    expect(rendered.applePng.equals(read("src/app/apple-icon.png"))).toBe(true);
    expect(rendered.favicon.equals(read("src/app/favicon.ico"))).toBe(true);
  });
});
