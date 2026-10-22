import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import type { ResultTier } from "@/lib/challenge-tier";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

export interface OgDetailLine {
  text: string;
  tone: "body" | "meta" | "verify";
}

export interface OgLines {
  kicker: string;
  title: string;
  subtitle: string;
  foot: string;
  score?: string | null;
  /** Present on a receipt card. Challenge landing cards leave this empty. */
  lines?: OgDetailLine[];
  actions?: string[];
  tier?: ResultTier | null;
}

const DAY = {
  sheet: "#F5F7FA",
  card: "#FFFFFF",
  ink: "#0E1726",
  ink2: "#4A5568",
  blue: "#1F4BD8",
  ok: "#0F7A55",
};

interface FontFile {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: "normal";
}

async function readFont(file: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "assets/fonts", file));
}

function lineStyle(line: OgDetailLine): { fontFamily: string; fontSize: number; color: string; marginTop: number } {
  switch (line.tone) {
    case "body":
      return { fontFamily: "Public Sans", fontSize: 28, color: DAY.ink, marginTop: 14 };
    case "meta":
      return { fontFamily: "JetBrains Mono", fontSize: 22, color: DAY.ink2, marginTop: 10 };
    case "verify":
      return { fontFamily: "JetBrains Mono", fontSize: 22, color: DAY.blue, marginTop: 16 };
    default: {
      const unknown: never = line.tone;
      return unknown;
    }
  }
}

function headlineColor(tier: ResultTier | null | undefined): string {
  if (tier === "Strong") return DAY.ok;
  if (tier === "Still sharpening") return DAY.blue;
  return DAY.ink;
}

/**
 * Shared 1200×630 card. A receipt passes detail lines and is drawn in the
 * titleblock frame. A challenge landing card passes only the four text
 * fields and keeps the simpler frame.
 */
export async function renderOgCard(lines: OgLines, cacheControl?: string) {
  const rich = Boolean(lines.lines && lines.lines.length > 0);
  const [display, body, bodyStrong, mono] = await Promise.all([
    readFont("Sora_700Bold.ttf"),
    readFont("PublicSans_400Regular.ttf"),
    rich ? readFont("PublicSans_600SemiBold.ttf") : Promise.resolve(null),
    rich ? readFont("JetBrainsMono_400Regular.ttf") : Promise.resolve(null),
  ]);
  const fonts: FontFile[] = [
    { name: "Sora", data: display, weight: 700, style: "normal" },
    { name: "Public Sans", data: body, weight: 400, style: "normal" },
  ];
  if (bodyStrong) fonts.push({ name: "Public Sans", data: bodyStrong, weight: 600, style: "normal" });
  if (mono) fonts.push({ name: "JetBrains Mono", data: mono, weight: 400, style: "normal" });

  const tree = rich ? receiptCard(lines) : landingCard(lines);
  return new ImageResponse(tree, {
    ...ogSize,
    fonts,
    headers: cacheControl ? { "Cache-Control": cacheControl } : undefined,
  });
}

function landingCard(lines: OgLines) {
  const titleSize = lines.title.length > 48 ? 48 : 68;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: DAY.sheet,
        color: DAY.ink,
        padding: "64px",
        fontFamily: "Public Sans",
      }}
    >
      <div style={{ display: "flex", fontFamily: "Sora", fontSize: 22, letterSpacing: 3, color: DAY.blue }}>
        {lines.kicker.toUpperCase()}
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontFamily: "Sora", fontSize: titleSize, lineHeight: 1.15 }}>{lines.title}</div>
        {lines.subtitle ? (
          <div style={{ display: "flex", marginTop: 20, fontSize: 30, color: DAY.ink2 }}>{lines.subtitle}</div>
        ) : null}
        {lines.score ? (
          <div style={{ display: "flex", marginTop: 24, fontFamily: "Sora", fontSize: 64 }}>{lines.score}</div>
        ) : null}
      </div>
      <div style={{ display: "flex", fontSize: 24, color: DAY.ink2 }}>{lines.foot}</div>
    </div>
  );
}

function receiptCard(lines: OgLines) {
  const headlineSize = lines.title.length > 22 ? 56 : 68;
  const detail = lines.lines ?? [];
  const actions = lines.actions ?? [];
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        background: DAY.sheet,
        color: DAY.ink,
        padding: 36,
        fontFamily: "Public Sans",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          background: DAY.card,
          border: `3px solid ${DAY.ink}`,
          padding: "42px 48px",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 20,
              letterSpacing: 3,
              color: DAY.blue,
            }}
          >
            {lines.kicker.toUpperCase()}
          </div>
          <div
            style={{
              display: "flex",
              fontFamily: "JetBrains Mono",
              fontSize: 18,
              letterSpacing: 2,
              color: DAY.ink2,
            }}
          >
            UNDERSTANDING RECEIPT
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 36 }}>
          <div
            style={{
              display: "flex",
              fontFamily: "Sora",
              fontSize: headlineSize,
              lineHeight: 1.05,
              color: headlineColor(lines.tier),
            }}
          >
            {lines.title}
          </div>
          {detail.map((line, index) => {
            const style = lineStyle(line);
            return (
              <div
                key={`${line.tone}-${index}`}
                style={{
                  display: "flex",
                  fontFamily: style.fontFamily,
                  fontSize: style.fontSize,
                  color: style.color,
                  marginTop: style.marginTop,
                }}
              >
                {line.text}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", marginTop: "auto", paddingTop: 28, alignItems: "center" }}>
          {actions.map((label) => (
            <div
              key={label}
              style={{
                display: "flex",
                border: `2px solid ${DAY.ink}`,
                padding: "10px 18px",
                marginRight: 16,
                fontFamily: "Sora",
                fontSize: 22,
                color: DAY.ink,
              }}
            >
              {label}
            </div>
          ))}
          {lines.foot ? (
            <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: DAY.ink2 }}>{lines.foot}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
