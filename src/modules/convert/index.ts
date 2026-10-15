// Convert Word/OpenDocument/RTF supplementary files to PDF inside Zotero.
//
// 1. LibreOffice, if installed (best fidelity; handles DOC/ODT/RTF too).
// 2. DOCX only: mammoth -> HTML, printed to PDF by Zotero's own Gecko
//    print engine in a hidden browser (keeps fonts, tables, images).
// 3. DOCX only: a plain pdf-lib rendering of the same HTML.

import type { ConvertibleType } from "../fetch/files";
import { getPref } from "../../utils/prefs";
import { docxToHTML, renderHTMLToPDF } from "./html";
import { getHiddenBrowserClass, localBytes, makeTempDir } from "../../utils/gecko";

export async function convertToPDF(
  bytes: Uint8Array,
  type: ConvertibleType,
  name: string,
): Promise<{ bytes: Uint8Array; method: string; failures: string[] }> {
  // Why better methods were skipped, for the debug log and tests.
  const failures: string[] = [];
  const soffice = await findLibreOffice();
  if (soffice) {
    try {
      return {
        bytes: await convertWithLibreOffice(soffice, bytes, type),
        method: "LibreOffice",
        failures,
      };
    } catch (e: any) {
      ztoolkit.log("LibreOffice conversion failed, trying built-in", e);
      failures.push(`LibreOffice: ${e?.message ?? e}`);
    }
  }

  if (type !== "docx") {
    throw new Error(`converting .${type} files needs LibreOffice`);
  }

  const html = await docxToHTML(bytes, name);
  try {
    return { bytes: await printHTMLToPDF(html), method: "print", failures };
  } catch (e: any) {
    ztoolkit.log("Printing to PDF failed, using simple renderer", e);
    failures.push(`print: ${e?.message ?? e} ${e?.stack ?? ""}`);
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { bytes: await renderHTMLToPDF(doc), method: "simple", failures };
}

// ---------------------------------------------------------------------------
// LibreOffice

let sofficeCache: string | null | undefined;

async function findLibreOffice(): Promise<string | undefined> {
  const custom = (getPref("libreOfficePath") || "").trim();
  if (custom) {
    return (await IOUtils.exists(custom)) ? custom : undefined;
  }
  if (sofficeCache !== undefined) return sofficeCache ?? undefined;

  const candidates: string[] = [];
  if (Zotero.isWin) {
    for (const root of [
      "C:\\Program Files\\LibreOffice",
      "C:\\Program Files (x86)\\LibreOffice",
    ]) {
      candidates.push(`${root}\\program\\soffice.exe`);
    }
  } else if (Zotero.isMac) {
    candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice");
  } else {
    candidates.push(
      "/usr/bin/soffice",
      "/usr/bin/libreoffice",
      "/usr/lib/libreoffice/program/soffice",
      "/opt/libreoffice/program/soffice",
      "/snap/bin/libreoffice",
      "/usr/local/bin/soffice",
    );
  }
  for (const path of candidates) {
    if (await IOUtils.exists(path)) return (sofficeCache = path);
  }
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  for (const name of ["soffice", "libreoffice"]) {
    try {
      return (sofficeCache = await Subprocess.pathSearch(name));
    } catch {
      // not on PATH
    }
  }
  sofficeCache = null;
  return undefined;
}

async function convertWithLibreOffice(
  soffice: string,
  bytes: Uint8Array,
  type: ConvertibleType,
): Promise<Uint8Array> {
  const { Subprocess } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs",
  );
  const dir = await makeTempDir("lo");
  try {
    const input = PathUtils.join(dir, `supplementary.${type}`);
    await IOUtils.write(input, bytes);
    // A private profile, so this works even while LibreOffice is open.
    const profile = Zotero.File.pathToFileURI(PathUtils.join(dir, "profile"));
    const proc = await Subprocess.call({
      command: soffice,
      arguments: [
        `-env:UserInstallation=${profile}`,
        "--headless",
        "--norestore",
        "--nologo",
        "--convert-to",
        "pdf",
        "--outdir",
        dir,
        input,
      ],
      stderr: "stdout",
    });
    // Drain output so the process can't block on a full pipe.
    void (async () => {
      try {
        while (await proc.stdout.readString());
      } catch {
        // closed
      }
    })();
    const timeout = Zotero.Promise.delay(180000).then(() => {
      proc.kill();
      throw new Error("LibreOffice timed out");
    });
    const { exitCode } = await Promise.race([proc.wait(), timeout]);
    const output = PathUtils.join(dir, "supplementary.pdf");
    if (exitCode !== 0 || !(await IOUtils.exists(output))) {
      throw new Error(`LibreOffice exited with code ${exitCode}`);
    }
    return localBytes(await IOUtils.read(output));
  } finally {
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  }
}

// ---------------------------------------------------------------------------
// Gecko print-to-PDF

const PRINT_TIMEOUT = 90000;

async function printHTMLToPDF(html: string): Promise<Uint8Array> {
  const HiddenBrowser = await getHiddenBrowserClass();
  const dir = await makeTempDir("print");
  const path = PathUtils.join(dir, "supplementary.html");
  await IOUtils.writeUTF8(path, html);
  // Printing needs a browser in a real window, not a windowless frame.
  const browser = new HiddenBrowser({ useHiddenFrame: false });
  // Loading or printing can stall without an error (seen with large SI);
  // give up so the simple renderer still produces a PDF.
  const timeout = Zotero.Promise.delay(PRINT_TIMEOUT).then(() => {
    throw new Error(`print timed out after ${PRINT_TIMEOUT / 1000} s`);
  });
  try {
    return await Promise.race([print(browser, path), timeout]);
  } finally {
    browser.destroy();
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  }
}

async function print(browser: any, path: string): Promise<Uint8Array> {
  if (!(await browser.load(path))) throw new Error("could not load HTML");
  if (typeof browser.waitForDocument === "function") {
    await browser.waitForDocument();
  } else {
    await Zotero.Promise.delay(1500);
  }

  const Ci = Components.interfaces;
  const settings = (Components.classes as any)["@mozilla.org/gfx/printsettings-service;1"]
    .getService(Ci.nsIPrintSettingsService)
    .createNewPrintSettings();
  // Print settings change between Gecko versions; assigning one that no
  // longer exists throws, so set each optional one defensively.
  const set = (name: string, value: unknown) => {
    try {
      if (name in settings) settings[name] = value;
    } catch (e) {
      ztoolkit.log(`print setting ${name} not supported`, e);
    }
  };
  set("isInitializedFromPrinter", true);
  set("isInitializedFromPrefs", true);
  set("printSilent", true);
  set("showPrintProgress", false);
  set("printerName", "Mozilla Save to PDF");
  set("paperSizeUnit", Ci.nsIPrintSettings.kPaperSizeInches);
  set("paperWidth", 8.27); // A4
  set("paperHeight", 11.69);
  set("usePageRuleSizeAsPaperSize", true);
  for (const side of ["Top", "Bottom", "Left", "Right"]) {
    set(`margin${side}`, 0.4);
  }
  for (const pos of ["Left", "Center", "Right"]) {
    set(`headerStr${pos}`, "");
    set(`footerStr${pos}`, "");
  }
  set("printBGColors", true);
  set("printBGImages", true);
  set("shrinkToFit", true);
  // Required ones: let these throw if they ever stop working.
  settings.outputFormat = Ci.nsIPrintSettings.kOutputFormatPDF;

  const storage = (Components.classes as any)["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
  storage.init(65536, 0xffffffff);
  settings.outputDestination = Ci.nsIPrintSettings.kOutputDestinationStream;
  settings.outputStream = storage.getOutputStream(0);

  await browser.browsingContext.print(settings);

  const input = (Components.classes as any)["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
  input.setInputStream(storage.newInputStream(0));
  const bytes = new Uint8Array(input.readByteArray(input.available()));
  input.close();
  if (bytes.length < 100) throw new Error("print produced no output");
  return bytes;
}
