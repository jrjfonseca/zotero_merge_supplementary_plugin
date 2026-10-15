import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from "pdf-lib";
import { appendSupplements } from "../src/modules/pdf.ts";

async function makePDF(pages: number, title?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

function outlineTitles(doc: PDFDocument): string[] {
  const outlines = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  if (!outlines) return [];
  const titles: string[] = [];
  let ref = outlines.get(PDFName.of("First"));
  while (ref instanceof PDFRef) {
    const item = doc.context.lookup(ref, PDFDict);
    titles.push((item.lookup(PDFName.of("Title")) as any).decodeText());
    ref = item.get(PDFName.of("Next"));
  }
  return titles;
}

test("appends every supplement after the main pages", async () => {
  const result = await appendSupplements(await makePDF(3, "Main title"), [
    { bytes: await makePDF(2), label: "SI 1" },
    { bytes: await makePDF(4), label: "SI 2" },
  ]);
  assert.equal(result.mainPages, 3);
  assert.equal(result.totalPages, 9);

  const merged = await PDFDocument.load(result.bytes);
  assert.equal(merged.getPageCount(), 9);
  assert.equal(merged.getTitle(), "Main title");
  assert.deepEqual(outlineTitles(merged), ["Main article", "SI 1", "SI 2"]);
  const outlines = merged.catalog.lookup(PDFName.of("Outlines"), PDFDict);
  assert.equal(outlines.lookup(PDFName.of("Count"), PDFNumber).asNumber(), 3);
});

test("extends an existing outline instead of replacing it", async () => {
  const first = await appendSupplements(await makePDF(2), [
    { bytes: await makePDF(1), label: "SI 1" },
  ]);
  const second = await appendSupplements(first.bytes, [
    { bytes: await makePDF(1), label: "SI 2" },
  ]);
  const merged = await PDFDocument.load(second.bytes);
  assert.equal(merged.getPageCount(), 4);
  assert.deepEqual(outlineTitles(merged), ["Main article", "SI 1", "SI 2"]);
});

test("outline can be turned off", async () => {
  const result = await appendSupplements(
    await makePDF(1),
    [{ bytes: await makePDF(1), label: "SI" }],
    { addOutline: false },
  );
  const merged = await PDFDocument.load(result.bytes);
  assert.deepEqual(outlineTitles(merged), []);
});
