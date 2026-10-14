import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { Discovery, startURLs, type Net, type Page } from "../src/modules/fetch/discover.ts";
import { makeDOCX, makePDF, parseHTML } from "./helpers.ts";

const CHALLENGE = "<html><head><title>Just a moment...</title></head><body></body></html>";

/** A fake web: url -> response. Pages are HTML strings, files are bytes. */
function fakeNet(
  site: Record<string, string | Uint8Array | number>,
  rendered: Record<string, string> = {},
  epmc?: Uint8Array,
  captions?: Record<string, string>,
) {
  const log: string[] = [];
  const page = (url: string, html: string, viaBrowser: boolean): Page => ({
    url,
    html,
    doc: parseHTML(html),
    status: html === CHALLENGE ? 403 : 200,
    viaBrowser,
  });
  let cleared = false;
  const retried = new Set<string>();
  const net: Net = {
    async fetchPage(url) {
      log.push(`GET ${url}`);
      const r = site[url];
      if (typeof r === "number") return { ...page(url, "", false), status: r };
      return typeof r === "string" ? page(url, r, false) : null;
    },
    async renderPage(url) {
      log.push(`RENDER ${url}`);
      cleared = true;
      const html = rendered[url];
      return html ? page(url, html, true) : null;
    },
    async download(url) {
      log.push(`DL ${url}`);
      let r = site[url];
      if (typeof r === "number" && retried.has(url) && site[`${url}#retry`]) r = site[`${url}#retry`];
      if (typeof r === "number") retried.add(url);
      if (r === 403 && cleared && site[`${url}#after-check`]) r = site[`${url}#after-check`];
      if (typeof r === "number") return { url, status: r };
      if (r === undefined) return { url, status: 404 };
      return { url, status: 200, bytes: typeof r === "string" ? strToU8(r) : r };
    },
    async europePMC() {
      log.push("EPMC");
      return epmc ? { url: "epmc", status: 200, bytes: epmc, captions } : null;
    },
    parseHTML,
    sleep: async () => {
      log.push("SLEEP");
    },
  };
  return { net, log };
}

test("downloads SI files linked from the article page, converting nothing itself", async () => {
  const pdf = await makePDF(3);
  const docx = makeDOCX(["Table S1"]);
  const { net } = fakeNet({
    "https://doi.org/10.1/a": `<div id="supplementary"><h2>Supplementary Information</h2>
      <a href="https://cdn.example/a_si_001.pdf">SI</a>
      <a href="https://cdn.example/a_si_002.docx">Table S1</a></div>`,
    "https://cdn.example/a_si_001.pdf": pdf,
    "https://cdn.example/a_si_002.docx": docx,
  });
  const files = await new Discovery(net, () => {}, "10.1/a").run(startURLs("10.1/a"));
  assert.deepEqual(files.map((f) => [f.name, f.type]), [
    ["a_si_001.pdf", "pdf"],
    ["a_si_002.docx", "docx"],
  ]);
});

test("bot-protected page falls back to the browser engine", async () => {
  const { net, log } = fakeNet(
    { "https://doi.org/10.1/b": CHALLENGE, "https://pub.example/suppl_file/b_si_001.pdf": await makePDF(1) },
    { "https://doi.org/10.1/b": `<a href="https://pub.example/suppl_file/b_si_001.pdf">Supporting Information</a>` },
  );
  const files = await new Discovery(net, () => {}, "10.1/b").run(startURLs("10.1/b"));
  assert.equal(files.length, 1);
  assert.ok(log.includes("RENDER https://doi.org/10.1/b"));
});

test("SI listing pages are followed and ZIP archives unpacked", async () => {
  const zip = zipSync({ "SI.pdf": await makePDF(2), "data.xlsx": strToU8("x") });
  const { net } = fakeNet({
    "https://doi.org/10.1/c": `<a href="https://pub.example/doi/suppl/10.1/c">Supporting Information</a>`,
    "https://pub.example/doi/suppl/10.1/c": `<a href="https://pub.example/doi/suppl/10.1/c/suppl_file/c_si.zip">c_si.zip</a>`,
    "https://pub.example/doi/suppl/10.1/c/suppl_file/c_si.zip": zip,
  });
  const files = await new Discovery(net, () => {}, "10.1/c").run(startURLs("10.1/c"));
  assert.deepEqual(files.map((f) => f.name), ["SI.pdf"]);
});

test("refused file downloads are retried after passing the bot check", async () => {
  const url = "https://pub.example/suppl_file/d_si_001.pdf";
  const { net, log } = fakeNet({
    "https://doi.org/10.1/d": `<a href="${url}">Supporting Information</a>`,
    [url]: 403,
    [`${url}#after-check`]: await makePDF(1),
  });
  const files = await new Discovery(net, () => {}, "10.1/d").run(startURLs("10.1/d"));
  assert.equal(files.length, 1);
  assert.equal(log.filter((l) => l === `DL ${url}`).length, 2);
});

test("falls back to Europe PMC when the publisher has nothing", async () => {
  const epmc = zipSync({ "Table_1.docx": makeDOCX(["x"]), "fig1.jpg": strToU8("x") });
  const { net } = fakeNet({ "https://doi.org/10.1/e": "<p>No SI here</p>" }, {}, epmc);
  const reports: string[] = [];
  const files = await new Discovery(net, (k) => reports.push(k), "10.1/e").run(startURLs("10.1/e"));
  assert.deepEqual(files.map((f) => [f.name, f.type]), [["Table_1.docx", "docx"]]);
  assert.ok(reports.includes("fetch-progress-pmc"));
});

test("the same file linked twice is returned once", async () => {
  const pdf = await makePDF(1);
  const { net } = fakeNet({
    "https://doi.org/10.1/f": `<div class="supplementary-material">
      <a href="https://pub.example/suppl_file/f_si_001.pdf">view</a>
      <a href="https://pub.example/suppl_file/f_si_001.pdf?download=true">download</a></div>`,
    "https://pub.example/suppl_file/f_si_001.pdf": pdf,
    "https://pub.example/suppl_file/f_si_001.pdf?download=true": pdf,
  });
  const files = await new Discovery(net, () => {}, "10.1/f").run(startURLs("10.1/f"));
  assert.equal(files.length, 1);
});

test("start URLs: item URL first, never a direct PDF link", () => {
  assert.deepEqual(startURLs("10.1/x", "https://pub.example/article/x"), [
    "https://pub.example/article/x",
    "https://doi.org/10.1/x",
  ]);
  assert.deepEqual(startURLs("10.1/x", "https://pub.example/x.pdf"), ["https://doi.org/10.1/x"]);
});

test("Europe PMC files captioned as paperwork are dropped", async () => {
  const epmc = zipSync({
    "x_MOESM1_ESM.pdf": await makePDF(2),
    "x_MOESM2_ESM.pdf": await makePDF(1),
  });
  const { net } = fakeNet({ "https://doi.org/10.1/g": "<p>nothing</p>" }, {}, epmc, {
    "x_MOESM1_ESM.pdf": "Supplementary Information Methods",
    "x_MOESM2_ESM.pdf": "Reporting Summary",
  });
  const files = await new Discovery(net, () => {}, "10.1/g").run(startURLs("10.1/g"));
  assert.deepEqual(files.map((f) => f.name), ["x_MOESM1_ESM.pdf"]);
});

test("temporary server errors are retried once", async () => {
  const url = "https://cdn.example/suppl_file/h_si_001.pdf";
  const page = `<a href="${url}">Supporting Information</a>`;
  const { net, log } = fakeNet(
    { "https://doi.org/10.1/h": page, [url]: 502, [`${url}#retry`]: await makePDF(1) },
  );
  const files = await new Discovery(net, () => {}, "10.1/h").run(startURLs("10.1/h"));
  assert.equal(files.length, 1);
  assert.equal(log.filter((l) => l === `DL ${url}`).length, 2);
});
