/**
 * Rasterize `src/app/icon.svg` into the Next.js app icons.
 *
 * The SVG is the only artwork. Day tokens live in that file (`--ink` and
 * `--card`, the light text colour on ink, from `src/app/globals.css`).
 * Replace the SVG, then run:
 *
 *   npm run brand-icon
 *
 * Writes `src/app/icon.png` (512), `src/app/apple-icon.png` (180, no alpha),
 * and `src/app/favicon.ico` (16, 32, 48).
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { fontPath } from "../src/lib/fonts";

const ROOT = process.cwd();
const SOURCE = join(ROOT, "src/app/icon.svg");

export type BrandIcons = {
  iconPng: Buffer;
  applePng: Buffer;
  favicon: Buffer;
};

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

/** Truecolor PNG (color type 2) so the apple tile has no alpha channel. */
function opaqueRgbPng(pixels: Buffer, width: number, height: number): Buffer {
  const expected = width * height * 4;
  if (pixels.length !== expected) {
    throw new Error(`expected ${expected} RGBA bytes, got ${pixels.length}`);
  }
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const alpha = pixels[src + 3]!;
      if (alpha !== 255) {
        throw new Error(`icon pixel at ${x},${y} has alpha ${alpha}; the SVG must cover the tile`);
      }
      const dest = row + 1 + x * 3;
      raw[dest] = pixels[src]!;
      raw[dest + 1] = pixels[src + 1]!;
      raw[dest + 2] = pixels[src + 2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function raster(svg: string, size: number) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: {
      loadSystemFonts: false,
      fontFiles: [fontPath("display")],
      defaultFontFamily: "Sora",
    },
  });
  const image = resvg.render();
  if (image.width !== size || image.height !== size) {
    throw new Error(`rendered ${image.width}x${image.height}, expected ${size}x${size}`);
  }
  return image;
}

function pngIco(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(16 * frames.length);
  let offset = 6 + directory.length;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const at = i * 16;
    directory[at] = frame.size;
    directory[at + 1] = frame.size;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(frame.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += frame.png.length;
  }
  return Buffer.concat([header, directory, ...frames.map((frame) => frame.png)]);
}

export function renderBrandIcons(svg: string): BrandIcons {
  const icon = raster(svg, 512);
  const apple = raster(svg, 180);
  const favicon = pngIco(
    [16, 32, 48].map((size) => ({ size, png: Buffer.from(raster(svg, size).asPng()) })),
  );
  return {
    iconPng: Buffer.from(icon.asPng()),
    applePng: opaqueRgbPng(apple.pixels, apple.width, apple.height),
    favicon,
  };
}

function writeBrandIcons(): void {
  const svg = readFileSync(SOURCE, "utf8");
  const icons = renderBrandIcons(svg);
  writeFileSync(join(ROOT, "src/app/icon.png"), icons.iconPng);
  writeFileSync(join(ROOT, "src/app/apple-icon.png"), icons.applePng);
  writeFileSync(join(ROOT, "src/app/favicon.ico"), icons.favicon);
  console.log("wrote src/app/icon.png, src/app/apple-icon.png, src/app/favicon.ico");
}

if (process.argv[1]?.endsWith("brand-icon.ts")) {
  writeBrandIcons();
}
