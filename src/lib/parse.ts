// Parsers load on demand: a parser that fails to initialise in one runtime
// must not take down routes that never parse files.

/** Parse in memory: uploads are never written to disk. */
export async function extractText(
  buffer: Buffer,
  mimeType: string,
  fileName: string,
): Promise<string> {
  const lower = fileName.toLowerCase();

  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    // pdf-parse/worker sets up the canvas polyfill pdfjs needs in serverless Node.
    const { CanvasFactory } = await import("pdf-parse/worker");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer, CanvasFactory });
    try {
      const result = await parser.getText();
      return (result.text || "").trim();
    } finally {
      await parser.destroy();
    }
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || "").trim();
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "application/vnd.ms-excel" ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".csv")
  ) {
    return extractSpreadsheetText(buffer, await import("xlsx"));
  }

  if (
    mimeType.startsWith("text/") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown")
  ) {
    return decodePlainText(buffer).trim();
  }

  return decodePlainText(buffer).trim();
}

/**
 * UTF-8 when the bytes are valid UTF-8. Otherwise Windows-1252, which is how
 * a Spanish or Portuguese .txt from an older editor usually arrives (ñ is
 * 0xF1). `buffer.toString("utf8")` would replace those bytes with U+FFFD.
 */
export function decodePlainText(buffer: Buffer): string {
  const body = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? buffer.subarray(3) : buffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return decodeWindows1252(body);
  }
}

/** Bytes 0x80–0x9F that differ from Latin-1. Undefined slots become U+FFFD. */
const CP1252_80: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
};

function decodeWindows1252(buffer: Buffer): string {
  let out = "";
  for (const byte of buffer) {
    if (byte >= 0x80 && byte <= 0x9f) out += CP1252_80[byte] ?? "\uFFFD";
    else out += String.fromCharCode(byte);
  }
  return out;
}

function extractSpreadsheetText(buffer: Buffer, XLSX: typeof import("xlsx")): string {
  const workbook = XLSX.read(buffer, { type: "buffer", cellFormula: true });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    parts.push(`# Sheet: ${sheetName}`);

    const named = workbook.Workbook?.Names || [];
    for (const n of named) {
      if (n.Ref && n.Ref.includes(sheetName)) {
        parts.push(`Named range ${n.Name}: ${n.Ref}`);
      }
    }

    const rows = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(
      sheet,
      // Formatted text ("1.2%", "$12M"), not raw numbers, so questions match what the creator sees.
      { header: 1, defval: "", raw: false },
    ) as unknown[][];

    for (const row of rows.slice(0, 200)) {
      const cells = (row as unknown[]).map((c) => String(c ?? "").trim());
      if (cells.some((c) => c.length > 0)) {
        parts.push(cells.join(" | "));
      }
    }

    // Surface a sample of formulas when present
    const formulaHints: string[] = [];
    for (const addr of Object.keys(sheet)) {
      if (addr.startsWith("!")) continue;
      const cell = sheet[addr] as { f?: string; v?: unknown } | undefined;
      if (cell?.f) {
        formulaHints.push(`${addr}: =${cell.f} → ${cell.v ?? ""}`);
      }
      if (formulaHints.length >= 40) break;
    }
    if (formulaHints.length) {
      parts.push("## Key formulas");
      parts.push(...formulaHints);
    }
  }

  return parts.join("\n").trim();
}

export function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  return "text/plain";
}
