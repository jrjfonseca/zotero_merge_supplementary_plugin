// Try the supplementary-file discovery on real DOIs, outside Zotero:
//
//   npm run try-fetch -- 10.1038/s41586-021-03819-2 10.1371/journal.pone.0229668
//
// Node's fetch stands in for Zotero's HTTP client. If the `playwright`
// package is installed, Chromium stands in for Zotero's hidden browser
// (needed for script-rendered or bot-protected pages); otherwise those pages
// are skipped. Results are written to ./try-fetch-output/.

import { DOMParser } from "linkedom";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { docxToHTML, renderHTMLToPDF } from "../src/modules/convert/html.ts";
import { Discovery, startURLs, type Net } from "../src/modules/fetch/discover.ts";
import { parseJATSCaptions } from "../src/modules/fetch/files.ts";
import { appendSupplements } from "../src/modules/pdf.ts";

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0";
const OUT = "try-fetch-output";
const parse = (html: string) =>
  new DOMParser().parseFromString(html, "text/html") as unknown as Document;

let browser: any;
async function getBrowser() {
  if (browser !== undefined) return browser;
  try {
    const { chromium } = await import("playwright" as string);
    browser = await chromium.launch(
      process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
    );
  } catch {
    console.log("  (playwright not available: skipping browser rendering)");
    browser = null;
  }
  return browser;
}

const net: Net = {
  async fetchPage(url) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
      const html = await r.text();
      return { url: r.url, html, doc: parse(html), status: r.status, viaBrowser: false };
    } catch {
      return null;
    }
  },
  async renderPage(url) {
    const b = await getBrowser();
    if (!b) return null;
    const page = await b.newPage();
    try {
      const r = await page.goto(url, { timeout: 45000, waitUntil: "domcontentloaded" });
      await page.waitForTimeout(5000);
      const html = await page.content();
      return { url: page.url(), html, doc: parse(html), status: r?.status() ?? 0, viaBrowser: true };
    } catch {
      return null;
    } finally {
      await page.close();
    }
  },
  async download(url, referrer) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": UA, ...(referrer ? { Referer: referrer } : {}) },
      });
      if (!r.ok) return { url: r.url, status: r.status };
      const name = r.headers.get("content-disposition")?.match(/filename="?([^";]+)/)?.[1];
      return { url: r.url, status: r.status, bytes: new Uint8Array(await r.arrayBuffer()), name };
    } catch {
      return null;
    }
  },
  async europePMC(doi) {
    const query = encodeURIComponent(`DOI:"${doi}"`);
    const s = await (
      await fetch(`https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&resultType=lite&query=${query}`)
    ).json();
    const hit = s?.resultList?.result?.find((r: any) => r.pmcid);
    if (!hit) return null;
    const base = `https://www.ebi.ac.uk/europepmc/webservices/rest/${hit.pmcid}`;
    if (hit.hasSuppl === "N" || hit.isOpenAccess !== "Y") {
      return { url: `${base}/supplementaryFiles`, status: 404, pmcid: hit.pmcid };
    }
    const zip = await net.download(`${base}/supplementaryFiles`);
    if (!zip) return null;
    zip.pmcid = hit.pmcid;
    if (zip.bytes) zip.captions = parseJATSCaptions(await (await fetch(`${base}/fullTextXML`)).text());
    return zip;
  },
  async figshare(doi) {
    const r = await fetch("https://api.figshare.com/v2/articles/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search_for: `:resource_doi: ${doi}`, page_size: 20 }),
    });
    const out = [];
    for (const rec of r.ok ? await r.json() : []) {
      if (String(rec.resource_doi ?? "").toLowerCase() !== doi.toLowerCase()) continue;
      const d = await (await fetch(`https://api.figshare.com/v2/articles/${rec.id}`)).json();
      for (const f of d.files ?? []) {
        if (/\.(pdf|docx?|odt|rtf|pptx?|odp|zip)$/i.test(f.name)) out.push({ url: f.download_url, name: f.name, title: rec.title });
      }
    }
    return out;
  },
  parseHTML: parse,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Convert with LibreOffice if it is installed (as the plugin does). */
function libreOffice(bytes: Uint8Array, type: string): Uint8Array | undefined {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "try-fetch-"));
  try {
    const input = path.join(dir, `si.${type}`);
    fs.writeFileSync(input, bytes);
    execFileSync("soffice", [`-env:UserInstallation=file://${dir}/profile`, "--headless", "--convert-to", "pdf", "--outdir", dir, input], { stdio: "ignore", timeout: 180000 });
    return new Uint8Array(fs.readFileSync(path.join(dir, "si.pdf")));
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

fs.mkdirSync(OUT, { recursive: true });
for (const doi of process.argv.slice(2)) {
  const started = Date.now();
  console.log(`== ${doi}`);
  const files = await new Discovery(net, (key, args) => {
    if (key !== "fetch-progress-download") console.log(`  ${key} ${args ? JSON.stringify(args) : ""}`);
  }, doi).run(startURLs(doi));

  const supplements = [];
  for (const f of files) {
    let bytes = f.bytes;
    if (f.type !== "pdf") {
      const converted = libreOffice(f.bytes, f.type);
      if (converted) bytes = converted;
      else if (f.type === "docx") bytes = await renderHTMLToPDF(parse(await docxToHTML(f.bytes, f.name)));
      else {
        console.log(`  ${f.name}: .${f.type} needs LibreOffice (skipped here)`);
        continue;
      }
    }
    const pages = (await PDFDocument.load(bytes)).getPageCount();
    console.log(`  ${f.type} ${f.name}: ${pages} pages  <- ${f.source}`);
    supplements.push({ bytes, label: f.name });
  }
  if (supplements.length) {
    const main = await PDFDocument.create();
    main.addPage().drawText(`Main article placeholder for ${doi}`, { x: 40, y: 700, size: 14 });
    const merged = await appendSupplements(await main.save(), supplements);
    const file = path.join(OUT, `${doi.replace(/[^a-z0-9.]+/gi, "_")}.pdf`);
    fs.writeFileSync(file, merged.bytes);
    console.log(`  -> ${file} (${merged.totalPages} pages)`);
  } else {
    console.log("  no supplementary documents found");
  }
  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
await browser?.close();
