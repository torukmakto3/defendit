import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { extractText } from "../src/lib/parse";

describe("extractText (in memory)", () => {
  it("reads plain text and markdown", async () => {
    expect(await extractText(Buffer.from("# Memo\nRevenue grew 12%"), "text/markdown", "m.md")).toContain(
      "Revenue grew 12%",
    );
  });

  it("reads CSV", async () => {
    const out = await extractText(Buffer.from("metric,value\nchurn,1.2%\n"), "text/csv", "k.csv");
    expect(out).toContain("churn | 1.2%");
  });

  it("reads XLSX including formulas", async () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([["ARR", 100], ["Growth", 0.2]]);
    ws.C1 = { t: "n", f: "B1*(1+B2)", v: 120 };
    ws["!ref"] = "A1:C2";
    XLSX.utils.book_append_sheet(wb, ws, "Model");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const out = await extractText(buf, "", "model.xlsx");
    expect(out).toContain("# Sheet: Model");
    expect(out).toContain("ARR | 100");
    expect(out).toContain("=B1*(1+B2)");
  });
});
