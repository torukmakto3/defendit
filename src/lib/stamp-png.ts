import { Resvg } from "@resvg/resvg-js";
import { fontPath } from "./fonts";

/** PNG for pasting into email, Slack or Docs (2x for sharp text). Server only. */
export function renderStampPng(svg: string): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 1120 },
    font: {
      loadSystemFonts: false,
      fontFiles: [fontPath("mono"), fontPath("monoBold"), fontPath("display"), fontPath("body")],
      defaultFontFamily: "Public Sans",
    },
  });
  return Buffer.from(resvg.render().asPng());
}
