import { readFile } from "fs/promises";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

export async function extractTextFromFile(
  filePath: string,
  mimeType: string,
  fileName: string,
): Promise<string> {
  const lower = fileName.toLowerCase();
  const buffer = await readFile(filePath);

  if (
    mimeType === "application/pdf" ||
    lower.endsWith(".pdf")
  ) {
    const parser = new PDFParse({ data: buffer });
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
    const result = await mammoth.extractRawText({ buffer });
    return (result.value || "").trim();
  }

  if (
    mimeType.startsWith("text/") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".md") ||
    lower.endsWith(".markdown")
  ) {
    return buffer.toString("utf8").trim();
  }

  // Fallback: try utf8
  return buffer.toString("utf8").trim();
}

export function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "text/markdown";
  }
  return "text/plain";
}
