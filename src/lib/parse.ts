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
    return buffer.toString("utf8").trim();
  }

  return buffer.toString("utf8").trim();
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
      { header: 1, defval: "" },
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
