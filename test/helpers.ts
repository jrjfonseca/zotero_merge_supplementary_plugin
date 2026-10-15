import { DOMParser } from "linkedom";
import { PDFDocument } from "pdf-lib";

export function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

export async function makePDF(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

export { makeDOCX } from "./docx-fixture.ts";
