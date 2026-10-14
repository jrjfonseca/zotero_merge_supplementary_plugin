// PDF manipulation with pdf-lib. No Zotero APIs in here, so it can be tested
// in Node (see test/pdf.test.ts).

import {
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
} from "pdf-lib";

export class EncryptedPDFError extends Error {}

export interface SupplementInput {
  bytes: Uint8Array;
  /** Shown as the bookmark title for the first page of this supplement */
  label: string;
}

export interface MergeResult {
  bytes: Uint8Array;
  mainPages: number;
  totalPages: number;
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/encrypt|password/i.test(msg)) throw new EncryptedPDFError(msg);
    throw e;
  }
}

export async function countPages(bytes: Uint8Array): Promise<number> {
  return (await load(bytes)).getPageCount();
}

/**
 * Append the pages of each supplement to the main PDF.
 *
 * Pages are appended to the main document itself (rather than copied into a
 * new one), so its outline, links, named destinations and metadata survive.
 * A bookmark is added for the start of the main article (only if it had no
 * outline) and for the start of every supplement.
 */
export async function appendSupplements(
  mainBytes: Uint8Array,
  supplements: SupplementInput[],
  options: { addOutline?: boolean; mainLabel?: string } = {},
): Promise<MergeResult> {
  const doc = await load(mainBytes);
  const mainPages = doc.getPageCount();
  const starts: { label: string; pageIndex: number }[] = [];

  for (const supp of supplements) {
    const src = await load(supp.bytes);
    const pages = await doc.copyPages(src, src.getPageIndices());
    if (pages.length === 0) continue;
    starts.push({ label: supp.label, pageIndex: doc.getPageCount() });
    for (const page of pages) doc.addPage(page);
  }

  if (options.addOutline !== false && starts.length > 0) {
    try {
      addOutlineEntries(doc, options.mainLabel ?? "Main article", starts);
    } catch {
      // Bookmarks are a nicety; never fail a merge over them.
    }
  }

  const totalPages = doc.getPageCount();
  const bytes = await doc.save();
  return { bytes, mainPages, totalPages };
}

/**
 * Append top-level bookmarks. If the document has no outline yet, one is
 * created with a first entry pointing at page 1 of the main article.
 */
function addOutlineEntries(
  doc: PDFDocument,
  mainLabel: string,
  entries: { label: string; pageIndex: number }[],
) {
  const ctx = doc.context;
  const catalog = doc.catalog;
  const pages = doc.getPages();

  let outlinesRef = catalog.get(PDFName.of("Outlines"));
  let outlines =
    outlinesRef instanceof PDFRef
      ? ctx.lookupMaybe(outlinesRef, PDFDict)
      : undefined;

  if (outlinesRef && !outlines) {
    // A direct (non-reference) or broken outline dict; leave it alone.
    return;
  }

  const toAdd = [...entries];
  if (!outlines) {
    outlines = ctx.obj({ Type: "Outlines", Count: 0 });
    outlinesRef = ctx.register(outlines);
    catalog.set(PDFName.of("Outlines"), outlinesRef);
    toAdd.unshift({ label: mainLabel, pageIndex: 0 });
  }
  const parentRef = outlinesRef as PDFRef;

  for (const entry of toAdd) {
    const pageRef = pages[entry.pageIndex].ref;
    const item = ctx.obj({
      Title: PDFHexString.fromText(entry.label),
      Parent: parentRef,
      Dest: [pageRef, "Fit"],
    });
    const itemRef = ctx.register(item);

    const lastRef = outlines.get(PDFName.of("Last"));
    const last =
      lastRef instanceof PDFRef ? ctx.lookupMaybe(lastRef, PDFDict) : undefined;
    if (lastRef instanceof PDFRef && last) {
      item.set(PDFName.of("Prev"), lastRef);
      last.set(PDFName.of("Next"), itemRef);
    } else {
      outlines.set(PDFName.of("First"), itemRef);
    }
    outlines.set(PDFName.of("Last"), itemRef);

    const count = outlines.lookupMaybe(PDFName.of("Count"), PDFNumber);
    const n = count ? Math.abs(count.asNumber()) : 0;
    outlines.set(PDFName.of("Count"), PDFNumber.of(n + 1));
  }
}
