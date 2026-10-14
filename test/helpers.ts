import { DOMParser } from "linkedom";
import { strToU8, zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

export function parseHTML(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html") as unknown as Document;
}

export async function makePDF(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([200, 200]);
  return doc.save();
}

/** A minimal but valid DOCX with the given paragraphs and one table. */
export function makeDOCX(paragraphs: string[], table?: string[][]): Uint8Array {
  const esc = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const p = (t: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const tbl = table
    ? `<w:tbl>${table
        .map((row) => `<w:tr>${row.map((c) => `<w:tc>${p(c)}</w:tc>`).join("")}</w:tr>`)
        .join("")}</w:tbl>`
    : "";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs
    .map(p)
    .join("")}${tbl}</w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/document.xml": strToU8(document),
  });
}
