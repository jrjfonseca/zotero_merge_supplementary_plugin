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
  extra: { figshare?: { url: string; name: string; title?: string }[]; pmcid?: string } = {},
) {
  const log: string[] = [];
  const page = (url: string, html: string, viaBrowser: boolean): Page => ({
    url,
    html,
    doc: parseHTML(html),
    status: html === CHALLENGE ? 403 : 200,
    viaBrowser,
  });
  // Hosts whose bot check was passed (cookies are per host)
  const cleared = new Set<string>();
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
      cleared.add(new URL(url).host);
      const html = rendered[url];
      return html ? page(url, html, true) : null;
    },
    async download(url) {
      log.push(`DL ${url}`);
      let r = site[url];
      if (typeof r === "number" && retried.has(url) && site[`${url}#retry`]) r = site[`${url}#retry`];
      if (typeof r === "number") retried.add(url);
      if (r === 403 && cleared.has(new URL(url).host) && site[`${url}#after-check`]) r = site[`${url}#after-check`];
      if (typeof r === "number") return { url, status: r };
      if (r === undefined) return { url, status: 404 };
      return { url, status: 200, bytes: typeof r === "string" ? strToU8(r) : r };
    },
    async europePMC() {
      log.push("EPMC");
      if (epmc) return { url: "epmc", status: 200, bytes: epmc, captions, pmcid: extra.pmcid };
      return extra.pmcid ? { url: "epmc", status: 404, pmcid: extra.pmcid } : null;
    },
    async figshare() {
      log.push("FIGSHARE");
      return extra.figshare ?? [];
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

test("a file host other than the article's gets its own bot check passed", async () => {
  const article = "https://doi.org/10.1/d2";
  const url = "https://files.example/suppdata/d2_si_001.pdf";
  const { net, log } = fakeNet(
    { [article]: CHALLENGE, [url]: 403, [`${url}#after-check`]: await makePDF(1) },
    { [article]: `<a href="${url}">Supporting Information</a>` },
  );
  const files = await new Discovery(net, () => {}, "10.1/d2").run(startURLs("10.1/d2"));
  assert.equal(files.length, 1);
  assert.ok(log.includes("RENDER https://files.example/"), log.join("\n"));
  assert.equal(log.filter((l) => l === `RENDER ${article}`).length, 1);
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

test("falls back to Figshare deposits (e.g. ACS) when the publisher page is blocked", async () => {
  const pdf = await makePDF(2);
  const { net, log } = fakeNet(
    { "https://doi.org/10.1021/x": CHALLENGE, "https://ndownloader.figshare.com/files/1": pdf, "https://ndownloader.figshare.com/files/2": await makePDF(1) },
    {},
    undefined,
    undefined,
    {
      figshare: [
        { url: "https://ndownloader.figshare.com/files/1", name: "ja0c1_si_001.pdf", title: "Supporting Information" },
        { url: "https://ndownloader.figshare.com/files/2", name: "peer_review.pdf", title: "Peer Review File" },
      ],
    },
  );
  const files = await new Discovery(net, () => {}, "10.1021/x").run(startURLs("10.1021/x"));
  assert.deepEqual(files.map((f) => f.name), ["ja0c1_si_001.pdf"]);
  assert.ok(!log.includes("EPMC"), "stops once Figshare had the files");
});

test("falls back to the PubMed Central article page for non-open-access articles", async () => {
  const pmc = "https://pmc.ncbi.nlm.nih.gov/articles/PMC123/";
  const file = "https://pmc.ncbi.nlm.nih.gov/articles/instance/123/bin/abc_sm.pdf";
  const { net } = fakeNet(
    {
      "https://doi.org/10.1126/x": CHALLENGE,
      [pmc]: `<section id="supplementary-material"><h2>Supplementary Material</h2><a href="${file}">abc_sm.pdf</a></section>`,
      [file]: await makePDF(3),
    },
    {},
    undefined,
    undefined,
    { pmcid: "PMC123" },
  );
  const files = await new Discovery(net, () => {}, "10.1126/x").run(startURLs("10.1126/x"));
  assert.deepEqual(files.map((f) => f.name), ["abc_sm.pdf"]);
});

test("files listed in the article XML but missing from the Europe PMC archive come from PMC", async () => {
  const gifOnly = zipSync({ "f1.gif": strToU8("GIF89a") });
  const file = "https://pmc.ncbi.nlm.nih.gov/articles/PMC9/bin/NIHMS1-supplement-supplementary.pdf";
  const { net } = fakeNet(
    { "https://doi.org/10.1088/x": "<p>no links</p>", [file]: await makePDF(2) },
    {},
    gifOnly,
    { "NIHMS1-supplement-supplementary.pdf": "supplementary", "f1.gif": "Figure 1" },
    { pmcid: "PMC9" },
  );
  const files = await new Discovery(net, () => {}, "10.1088/x").run(startURLs("10.1088/x"));
  assert.deepEqual(files.map((f) => f.name), ["NIHMS1-supplement-supplementary.pdf"]);
});
