import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { CARD_HEIGHT, CARD_WIDTH, type CardLine, type ResultCard } from "@/lib/result-card";

const DAY = {
  sheet: "#F5F7FA",
  card: "#FFFFFF",
  ink: "#0E1726",
  ink2: "#4A5568",
  blue: "#1F4BD8",
  ok: "#0F7A55",
};

interface Fonts {
  display: Buffer;
  body: Buffer;
  bodyStrong: Buffer;
  mono: Buffer;
}

let fontsPromise: Promise<Fonts> | null = null;

function loadFonts(): Promise<Fonts> {
  if (!fontsPromise) {
    const dir = join(process.cwd(), "assets/fonts");
    fontsPromise = Promise.all([
      readFile(join(dir, "Sora_700Bold.ttf")),
      readFile(join(dir, "PublicSans_400Regular.ttf")),
      readFile(join(dir, "PublicSans_600SemiBold.ttf")),
      readFile(join(dir, "JetBrainsMono_400Regular.ttf")),
    ]).then(([display, body, bodyStrong, mono]) => ({ display, body, bodyStrong, mono }));
  }
  return fontsPromise;
}

function headlineColor(card: ResultCard): string {
  if (card.tier === "Strong") return DAY.ok;
  if (card.tier === "Still sharpening") return DAY.blue;
  return DAY.ink;
}

function lineStyle(line: CardLine): { fontFamily: string; fontSize: number; color: string; marginTop: number } {
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

/** 1200×630 receipt card. Node runtime: fonts are read from disk. */
export async function renderResultCard(card: ResultCard, cacheControl: string): Promise<ImageResponse> {
  const fonts = await loadFonts();
  const headlineSize = card.headline.length > 22 ? 56 : 68;
  return new ImageResponse(
    (
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
              {card.kicker}
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
                color: headlineColor(card),
              }}
            >
              {card.headline}
            </div>
            {card.lines.map((line, index) => {
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

          <div style={{ display: "flex", marginTop: "auto", paddingTop: 28 }}>
            {card.actions.map((label) => (
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
          </div>
        </div>
      </div>
    ),
    {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      fonts: [
        { name: "Sora", data: fonts.display, weight: 700, style: "normal" },
        { name: "Public Sans", data: fonts.body, weight: 400, style: "normal" },
        { name: "Public Sans", data: fonts.bodyStrong, weight: 600, style: "normal" },
        { name: "JetBrains Mono", data: fonts.mono, weight: 400, style: "normal" },
      ],
      headers: { "Cache-Control": cacheControl },
    },
  );
}
