import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const ogSize = { width: 1200, height: 630 };
export const ogContentType = "image/png";

export interface OgLines {
  kicker: string;
  title: string;
  subtitle: string;
  foot: string;
  score?: string | null;
}

export async function renderOgCard(lines: OgLines) {
  const [display, body] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/Sora_700Bold.ttf")),
    readFile(join(process.cwd(), "assets/fonts/PublicSans_400Regular.ttf")),
  ]);
  const titleSize = lines.title.length > 48 ? 48 : 68;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#F5F7FA",
          color: "#0E1726",
          padding: "64px",
          fontFamily: "Public Sans",
        }}
      >
        <div style={{ display: "flex", fontFamily: "Sora", fontSize: 22, letterSpacing: 3, color: "#1F4BD8" }}>
          {lines.kicker.toUpperCase()}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", fontFamily: "Sora", fontSize: titleSize, lineHeight: 1.15 }}>{lines.title}</div>
          {lines.subtitle ? (
            <div style={{ display: "flex", marginTop: 20, fontSize: 30, color: "#4A5568" }}>{lines.subtitle}</div>
          ) : null}
          {lines.score ? (
            <div style={{ display: "flex", marginTop: 24, fontFamily: "Sora", fontSize: 64 }}>{lines.score}</div>
          ) : null}
        </div>
        <div style={{ display: "flex", fontSize: 24, color: "#4A5568" }}>{lines.foot}</div>
      </div>
    ),
    {
      ...ogSize,
      fonts: [
        { name: "Sora", data: display, weight: 700, style: "normal" },
        { name: "Public Sans", data: body, weight: 400, style: "normal" },
      ],
    },
  );
}
