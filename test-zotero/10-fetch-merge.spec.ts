// End-to-end tests inside a real Zotero: they hit real publisher sites.
// Run with `npm run test:zotero` (see README, "Testing inside Zotero").

import { assert } from "chai";
import { PDFDocument } from "pdf-lib";
import { config } from "../package.json";
import { makeDOCX } from "../test/docx-fixture.ts";

const PREF = (key: string) => `${config.prefsPrefix}.${key}`;
const MERGED_TAG = "_merged-supplementary";
const REPORT = PathUtils.join(PathUtils.tempDir, "mergesupppdf-zotero-results.json");
const results: Record<string, unknown> = {};

function api(): any {
  return (Zotero as any)[config.addonInstance].api;
}

function localBytes(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(new ArrayBuffer(raw.byteLength));
  out.set(raw);
  return out;
}

async function pdfBytes(text: string, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    doc.addPage([400, 400]).drawText(`${text} p${i + 1}`, { x: 20, y: 200, size: 12 });
  }
  return doc.save();
}

async function pageCount(att: Zotero.Item): Promise<number> {
  const path = (await att.getFilePathAsync()) as string;
  return (await PDFDocument.load(localBytes(await IOUtils.read(path)))).getPageCount();
}

async function importPDF(parent: Zotero.Item, bytes: Uint8Array, name: string, title: string) {
  const dir = PathUtils.join(PathUtils.tempDir, `mergesupp-spec-${Date.now()}-${Math.random()}`);
  await IOUtils.makeDirectory(dir);
  const path = PathUtils.join(dir, name);
  await IOUtils.write(path, bytes);
  return Zotero.Attachments.importFromFile({ file: path, parentItemID: parent.id, title });
}

async function makeItem(doi: string, withMainPDF = true) {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", `Test ${doi}`);
  item.setField("DOI", doi);
  await item.saveTx();
  let main: Zotero.Item | undefined;
  if (withMainPDF) {
    main = await importPDF(item, await pdfBytes(`Main article ${doi}`), "main.pdf", "Full Text PDF");
  }
  return { item, main };
}

function pdfs(item: Zotero.Item, includeTrashed = false): Zotero.Item[] {
  return item
    .getAttachments(includeTrashed)
    .map((id) => Zotero.Items.get(id))
    .filter((a) => a.isPDFAttachment());
}

async function fetchAndCheck(doi: string, key = doi) {
  const { item, main } = await makeItem(doi);
  const started = Date.now();
  const steps: string[] = [];
  const outcome = await api().fetchAndMergeItem(item, {
    interactive: false,
    report: (text: string) =>
      steps.push(`${((Date.now() - started) / 1000).toFixed(1)}s ${text}`),
  });
  const supps = pdfs(item).filter((a) => a.id !== main!.id);
  let suppPages = 0;
  for (const s of supps) suppPages += await pageCount(s);
  const mainPages = await pageCount(main!);
  results[key] = {
    seconds: (Date.now() - started) / 1000,
    steps,
    status: outcome.status,
    merge: outcome.merge?.status,
    reason: outcome.reason ?? outcome.merge?.reason,
    notes: outcome.notes,
    attached: supps.map((s) => s.getDisplayTitle()),
    mainPages,
  };
  return { item, main: main!, outcome, supps, suppPages, mainPages };
}

after(async function () {
  await IOUtils.writeUTF8(REPORT, JSON.stringify(results, null, 2));
});

describe("Word to PDF conversion inside Zotero", function () {
  const docx = makeDOCX(
    ["Supporting Information", "Figure S1. A test figure caption with αβγ and 5 µm."],
    [["Sample", "Value"], ["A", "1.0"], ["B", "2.0"]],
  );

  it("uses LibreOffice when it is installed", async function () {
    const { bytes, method } = await api().convertToPDF(docx, "docx", "SI.docx");
    results["convert-libreoffice"] = { method, size: bytes.length };
    assert.equal(method, "LibreOffice");
    assert.isAtLeast((await PDFDocument.load(localBytes(bytes))).getPageCount(), 1);
  });

  it("converts RTF with LibreOffice", async function () {
    const rtf = new TextEncoder().encode("{\\rtf1\\ansi Supplementary RTF text\\par}");
    const { bytes, method } = await api().convertToPDF(rtf, "rtf", "SI.rtf");
    assert.equal(method, "LibreOffice");
    assert.isAtLeast((await PDFDocument.load(localBytes(bytes))).getPageCount(), 1);
  });

  it("prints DOCX to PDF with Zotero's engine when LibreOffice is missing", async function () {
    Zotero.Prefs.set(PREF("libreOfficePath"), "/nonexistent/soffice", true);
    try {
      let converted: any;
      try {
        converted = await api().convertToPDF(docx, "docx", "SI.docx");
      } catch (e: any) {
        results["convert-print-error"] = `${e?.message ?? e}\n${e?.stack ?? ""}`;
        throw e;
      }
      const { bytes, method, failures } = converted;
      results["convert-print"] = { method, size: bytes.length, failures };
      assert.equal(method, "print");
      assert.isAtLeast((await PDFDocument.load(localBytes(bytes))).getPageCount(), 1);

      // The text must really be in the PDF: let Zotero's PDF worker read it.
      const { item } = await makeItem("10.0000/print-check", false);
      const att = await importPDF(item, bytes, "printed.pdf", "printed.pdf");
      const text = (await (Zotero as any).PDFWorker.getFullText(att.id, 5, true)).text;
      results["convert-print"] = { method, size: bytes.length, text: text.slice(0, 200) };
      results["convert-print-text"] = text;
      assert.include(text, "Supporting Information");
      assert.include(text, "Figure S1");
    } finally {
      Zotero.Prefs.clear(PREF("libreOfficePath"), true);
    }
  });
});

describe("Zotero's hidden browser", function () {
  it("renders a script-built page so its SI links appear", async function () {
    const page = await api().fetchPageBrowser(
      "https://www.frontiersin.org/journals/microbiology/articles/10.3389/fmicb.2020.01800/full",
    );
    assert.isOk(page, "page loaded");
    assert.include(page.html, "supplementary-materials_tables_3_docx");
  });
});

describe("Fetch & Merge Supplementary Info (one click) on real articles", function () {
  for (const [doi, publisher] of [
    ["10.1371/journal.pone.0229668", "PLOS (4 SI PDFs)"],
    ["10.1038/s41586-021-03819-2", "Nature (SI PDF)"],
    ["10.3389/fmicb.2020.01800", "Frontiers (DOCX + PDF, page rendered by the browser)"],
    ["10.1016/S0140-6736(20)30183-5", "Lancet / Elsevier (CDN by PII)"],
    ["10.3390/molecules25030601", "MDPI (via Europe PMC)"],
  ]) {
    it(`${publisher}: ${doi}`, async function () {
      const { item, main, outcome, supps, suppPages, mainPages } = await fetchAndCheck(doi);
      assert.equal(outcome.status, "done", JSON.stringify(results[doi]));
      assert.equal(outcome.merge?.status, "merged", JSON.stringify(results[doi]));
      assert.isAbove(supps.length, 0);
      assert.equal(mainPages, 1 + suppPages, "main PDF = article + every SI page");
      for (const s of supps) assert.isTrue(s.hasTag(MERGED_TAG));
      // Publisher paperwork listed with the SI is not merged.
      assert.notMatch(
        supps.map((s) => s.getDisplayTitle()).join(" "),
        /41586_2021_3819_MOESM2/,
        "Nature's Reporting Summary is left out",
      );

      // A second click finds nothing new and never merges twice.
      const again = await api().fetchAndMergeItem(item, { interactive: false });
      assert.equal(again.status, "none");
      assert.equal(await pageCount(main), mainPages);
    });
  }
});

describe("More publishers (open-access articles with SI)", function () {
  // From this test machine some publisher sites block automated access, so
  // several of these come through Europe PMC rather than the publisher page.
  for (const [doi, publisher] of [
    ["10.1021/acsnano.2c07223", "ACS"],
    ["10.1039/d2ra07077d", "RSC"],
    ["10.1126/sciadv.abq3500", "AAAS (Science Advances)"],
    ["10.1080/12298093.2022.2158557", "Taylor & Francis (.doc SI)"],
    ["10.1093/nargab/lqac097", "OUP (SI zip inside a zip)"],
    ["10.1002/ece3.9677", "Wiley (DOCX SI)"],
    ["10.1088/1758-5090/aca3d4", "IOP"],
    ["10.1103/physrevx.12.041038", "APS"],
    ["10.1177/11786302221146892", "SAGE (DOCX SI)"],
    ["10.1007/s40820-022-00959-6", "Springer"],
  ]) {
    it(`${publisher}: ${doi}`, async function () {
      const { outcome, supps, suppPages, mainPages } = await fetchAndCheck(doi);
      const info = JSON.stringify(results[doi]);
      assert.equal(outcome.merge?.status, "merged", info);
      assert.isAbove(supps.length, 0, info);
      assert.equal(mainPages, 1 + suppPages, info);
    });
  }
});

describe("Without LibreOffice", function () {
  it("Frontiers DOCX files are converted by Zotero's print engine", async function () {
    Zotero.Prefs.set(PREF("libreOfficePath"), "/nonexistent/soffice", true);
    try {
      const doi = "10.3389/fmicb.2020.01800";
      const { outcome, supps, suppPages, mainPages } = await fetchAndCheck(doi, "frontiers-no-libreoffice");
      const info = JSON.stringify(results["frontiers-no-libreoffice"]);
      assert.equal(outcome.merge?.status, "merged", info);
      assert.equal(supps.length, 4, info);
      assert.equal(mainPages, 1 + suppPages);
    } finally {
      Zotero.Prefs.clear(PREF("libreOfficePath"), true);
    }
  });
});

describe("Getting the main PDF first", function () {
  it("runs Find Available PDF when the item has no PDF", async function () {
    const { item } = await makeItem("10.1371/journal.pone.0229668", false);
    const outcome = await api().fetchAndMergeItem(item, { interactive: false });
    const all = pdfs(item);
    results["no-main-pdf"] = {
      status: outcome.status,
      merge: outcome.merge?.status,
      reason: outcome.reason ?? outcome.merge?.reason,
      attachments: all.map((a) => a.getDisplayTitle()),
    };
    assert.isAtLeast(all.length, 2, JSON.stringify(results["no-main-pdf"]));
    assert.equal(outcome.merge?.status, "merged", JSON.stringify(results["no-main-pdf"]));
  });
});

describe("Auto-merge and undo", function () {
  it("merges an SI PDF as soon as it is attached", async function () {
    const { item, main } = await makeItem("10.0000/auto-merge");
    const si = await importPDF(item, await pdfBytes("SI", 3), "ja0c01234_si_001.pdf", "ja0c01234_si_001.pdf");
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !si.hasTag(MERGED_TAG)) {
      await Zotero.Promise.delay(1000);
    }
    assert.isTrue(si.hasTag(MERGED_TAG), "SI was tagged as merged");
    assert.equal(await pageCount(main!), 4);
  });

  it("Restore puts the original PDF back", async function () {
    const { item, main } = await fetchAndCheck("10.1371/journal.pone.0229668");
    assert.isAbove(await pageCount(main), 1);
    const outcome = await api().restoreItem(item);
    assert.equal(outcome.status, "merged");
    assert.equal(await pageCount(main), 1);
    for (const s of pdfs(item, true)) assert.isFalse(s.hasTag(MERGED_TAG));
  });
});

describe("Bot-protected publishers (recorded, not asserted)", function () {
  // From a normal connection Zotero's browser passes these sites' bot checks;
  // some sandboxes block the check itself, so only record what happens.
  for (const doi of [
    "10.1021/jacs.0c06363", // ACS
    "10.1002/anie.201916483", // Wiley
    "10.1039/c9ee02873k", // RSC
    "10.1126/science.abb2507", // Science
    "10.1073/pnas.2004064117", // PNAS
    "10.1080/14686996.2020.1730236", // Taylor & Francis
    "10.1093/nar/gkaa1100", // OUP
  ]) {
    it(doi, async function () {
      await fetchAndCheck(doi);
    });
  }
});
