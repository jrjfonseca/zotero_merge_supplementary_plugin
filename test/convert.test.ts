import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument } from "pdf-lib";
import { docxToHTML, renderHTMLToPDF } from "../src/modules/convert/html.ts";
import { makeDOCX, parseHTML } from "./helpers.ts";

test("DOCX becomes safe, standalone HTML", async () => {
  const html = await docxToHTML(
    makeDOCX(["Supporting Information", "<script>alert(1)</script>"], [["a", "b"], ["1", "2"]]),
    "SI.docx",
  );
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /Supporting Information/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("fallback renderer produces a valid PDF, paginating long content", async () => {
  const paragraphs = Array.from({ length: 300 }, (_, i) =>
    `Paragraph ${i}: αβγ ≤ 5 μm, T = 300 K ± 2 °C → done — CO₂ and m² ${"word ".repeat(20)}`,
  );
  const rows = Array.from({ length: 60 }, (_, i) => [`row ${i}`, "value", "x".repeat(80)]);
  const html = await docxToHTML(makeDOCX(paragraphs, rows), "SI.docx");
  const bytes = await renderHTMLToPDF(parseHTML(html));
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() > 5, `got ${pdf.getPageCount()} pages`);
});
