import { PDFDocument } from "pdf-lib";
import { getString } from "../utils/locale";

const SUPPLEMENTARY_PATTERNS = [
  /\bsupplementar/i,
  /\bsupporting\s*info/i,
  /\bsupp[\s._-]/i,
  /\bsupp$/i,
  /\bS\.?I\.?\b/,
  /\bsupport(ing)?\s*mat/i,
  /\bappendix/i,
  /\bsupplement\b/i,
];

function isSupplementaryTitle(title: string): boolean {
  return SUPPLEMENTARY_PATTERNS.some((pattern) => pattern.test(title));
}

interface IdentifiedPDFs {
  main: Zotero.Item;
  supplementary: Zotero.Item;
}

function identifyPDFs(parentItem: Zotero.Item): IdentifiedPDFs {
  const attachmentIDs = parentItem.getAttachments();
  const pdfAttachments: Zotero.Item[] = [];

  for (const id of attachmentIDs) {
    const att = Zotero.Items.get(id);
    if (att.attachmentContentType === "application/pdf") {
      pdfAttachments.push(att);
    }
  }

  if (pdfAttachments.length !== 2) {
    throw new Error(getString("merge-error-not-enough-pdfs"));
  }

  const [a, b] = pdfAttachments;
  const aTitle = a.getDisplayTitle();
  const bTitle = b.getDisplayTitle();
  const aIsSupp = isSupplementaryTitle(aTitle);
  const bIsSupp = isSupplementaryTitle(bTitle);

  if (aIsSupp && !bIsSupp) return { main: b, supplementary: a };
  if (bIsSupp && !aIsSupp) return { main: a, supplementary: b };

  // Fallback: check filenames
  const aFilename = a.attachmentFilename || "";
  const bFilename = b.attachmentFilename || "";
  const aFileIsSupp = isSupplementaryTitle(aFilename);
  const bFileIsSupp = isSupplementaryTitle(bFilename);

  if (aFileIsSupp && !bFileIsSupp) return { main: b, supplementary: a };
  if (bFileIsSupp && !aFileIsSupp) return { main: a, supplementary: b };

  throw new Error(getString("merge-error-no-supplementary"));
}

async function readPDFBytes(attachment: Zotero.Item): Promise<Uint8Array> {
  const filePath = await attachment.getFilePathAsync();
  if (!filePath) {
    throw new Error(
      getString("merge-error-file-missing", {
        args: { path: "(no path available)" },
      }),
    );
  }

  const exists = await IOUtils.exists(filePath);
  if (!exists) {
    throw new Error(
      getString("merge-error-file-missing", { args: { path: filePath } }),
    );
  }

  // Gecko's IOUtils returns a typed array from a different sandbox global,
  // so pdf-lib's instanceof checks fail. Create a completely fresh
  // ArrayBuffer + Uint8Array in the current scope and copy the data.
  const raw = await IOUtils.read(filePath);
  const buf = new ArrayBuffer(raw.byteLength);
  const arr = new Uint8Array(buf);
  arr.set(raw);
  return arr;
}

async function mergePDFs(
  mainBytes: Uint8Array,
  suppBytes: Uint8Array,
): Promise<Uint8Array> {
  const mainDoc = await PDFDocument.load(mainBytes);
  const suppDoc = await PDFDocument.load(suppBytes);

  const mergedDoc = await PDFDocument.create();

  // Preserve metadata from the main document
  const title = mainDoc.getTitle();
  if (title) mergedDoc.setTitle(title);
  const author = mainDoc.getAuthor();
  if (author) mergedDoc.setAuthor(author);
  const subject = mainDoc.getSubject();
  if (subject) mergedDoc.setSubject(subject);
  const keywords = mainDoc.getKeywords();
  if (keywords) mergedDoc.setKeywords([keywords]);
  const creator = mainDoc.getCreator();
  if (creator) mergedDoc.setCreator(creator);

  // Copy all main pages (copyPages preserves page-level annotations)
  const mainPages = await mergedDoc.copyPages(
    mainDoc,
    mainDoc.getPageIndices(),
  );
  for (const page of mainPages) {
    mergedDoc.addPage(page);
  }

  // Copy all supplementary pages
  const suppPages = await mergedDoc.copyPages(
    suppDoc,
    suppDoc.getPageIndices(),
  );
  for (const page of suppPages) {
    mergedDoc.addPage(page);
  }

  return await mergedDoc.save();
}

async function backupOriginalFile(filePath: string): Promise<string> {
  const dotIndex = filePath.lastIndexOf(".");
  const backupPath =
    dotIndex > 0
      ? filePath.substring(0, dotIndex) + ".backup" + filePath.substring(dotIndex)
      : filePath + ".backup";

  await IOUtils.copy(filePath, backupPath);
  return backupPath;
}

export async function performMerge(parentItem: Zotero.Item): Promise<void> {
  const progressWin = new ztoolkit.ProgressWindow(addon.data.config.addonName)
    .createLine({
      text: getString("merge-progress"),
      type: "default",
      progress: 0,
    })
    .show();

  try {
    // Identify main vs supplementary
    const { main, supplementary } = identifyPDFs(parentItem);
    ztoolkit.log(
      `Identified main="${main.getDisplayTitle()}", supp="${supplementary.getDisplayTitle()}"`,
    );

    // Read both PDF files
    const mainBytes = await readPDFBytes(main);
    const suppBytes = await readPDFBytes(supplementary);

    // Merge
    let mergedBytes: Uint8Array;
    try {
      mergedBytes = await mergePDFs(mainBytes, suppBytes);
    } catch (e: any) {
      if (
        e.message?.includes("encrypted") ||
        e.message?.includes("password")
      ) {
        throw new Error(getString("merge-error-encrypted"));
      }
      throw e;
    }

    // Backup original main PDF
    const mainPath = await main.getFilePathAsync();
    if (!mainPath) {
      throw new Error(
        getString("merge-error-file-missing", {
          args: { path: "(main PDF path)" },
        }),
      );
    }
    await backupOriginalFile(mainPath);

    // Write merged PDF in place of the original
    await IOUtils.write(mainPath, mergedBytes);

    // Notify Zotero that the file changed
    await main.saveTx();

    // Success
    progressWin.changeLine({
      text: getString("merge-success", {
        args: { mainTitle: main.getDisplayTitle() },
      }),
      type: "success",
      progress: 100,
    });
  } catch (e: any) {
    ztoolkit.log("Merge failed:", e);
    progressWin.changeLine({
      text: getString("merge-error-generic", {
        args: { message: e.message || String(e) },
      }),
      type: "error",
      progress: 100,
    });
  }
}
