import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { extractDocumentsFromZip, parseJATSCaptions, safeFileName, sniff } from "../src/modules/fetch/files.ts";
import { makeDOCX, makePDF } from "./helpers.ts";

test("sniffs file types from content", async () => {
  assert.equal(sniff(await makePDF(1)), "pdf");
  assert.equal(sniff(makeDOCX(["x"])), "docx");
  assert.equal(sniff(zipSync({ "a.txt": strToU8("hi") })), "zip");
  assert.equal(sniff(strToU8("<!DOCTYPE html><html></html>")), "html");
  assert.equal(sniff(strToU8("{\\rtf1\\ansi hello}")), "rtf");
  assert.equal(sniff(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), "doc");
  assert.equal(sniff(strToU8("col1,col2\n1,2")), "unknown");
});

test("extracts documents from a ZIP, ignoring other files", async () => {
  const pdf = await makePDF(2);
  const zip = zipSync({
    "SI/Data_Sheet_1.PDF": pdf,
    "SI/Table_1.docx": makeDOCX(["t"]),
    "SI/Table_2.xlsx": strToU8("x"),
    "__MACOSX/SI/._Data_Sheet_1.PDF": strToU8("junk"),
  });
  const files = extractDocumentsFromZip(zip);
  assert.deepEqual(files.map((f) => f.name).sort(), ["Data_Sheet_1.PDF", "Table_1.docx"]);
  assert.equal(files.find((f) => f.name.endsWith("PDF"))!.bytes.length, pdf.length);
});

test("keeps complete files from a truncated ZIP (Europe PMC streams)", async () => {
  const first = await makePDF(1);
  const zip = zipSync({ "a.pdf": first, "b.pdf": await makePDF(3) }, { level: 0 });
  const cut = zip.subarray(0, zip.length - 400); // lose the tail
  const files = extractDocumentsFromZip(cut);
  assert.deepEqual(files.map((f) => f.name), ["a.pdf"]);
  assert.equal(files[0].bytes.length, first.length);
});

test("safe file names", () => {
  assert.equal(safeFileName('a/b:c?.pdf'), "a_b_c_.pdf");
  assert.equal(safeFileName("Supplementary Information"), "Supplementary Information.pdf");
  assert.equal(safeFileName(""), "supplementary.pdf");
});

test("reads supplementary captions from JATS XML", () => {
  const xml = `<supplementary-material id="MOESM1"><label>Supplementary Information</label><caption><p>Methods</p></caption><media xlink:href="x_MOESM1_ESM.pdf"/></supplementary-material>
  <supplementary-material id="MOESM2"><media xlink:href="x_MOESM2_ESM.pdf"><caption><p>Reporting Summary</p></caption></media></supplementary-material>`;
  assert.deepEqual(parseJATSCaptions(xml), {
    "x_MOESM1_ESM.pdf": "Supplementary Information Methods",
    "x_MOESM2_ESM.pdf": "Reporting Summary",
  });
});

test("looks inside ZIP archives nested in ZIP archives", async () => {
  const inner = zipSync({ "SI_1.pdf": await makePDF(1), "data.csv": strToU8("x") });
  const outer = zipSync({ "article_supplemental_files.zip": inner, "fig1.jpg": strToU8("x") });
  assert.deepEqual(extractDocumentsFromZip(outer).map((f) => f.name), ["SI_1.pdf"]);
});
