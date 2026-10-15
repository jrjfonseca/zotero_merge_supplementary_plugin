import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alternativePages,
  extensionOf,
  extractSupplementaryLinks,
  findRedirect,
  guessedFileURLs,
  looksLikeChallenge,
  looksLikeTransit,
} from "../src/modules/fetch/links.ts";
import { parseHTML } from "./helpers.ts";

function links(html: string, url: string, doi?: string) {
  return extractSupplementaryLinks(parseHTML(html), url, { doi, html });
}

test("Springer Nature: SI section, skipping reporting summary and videos", () => {
  const html = `<html><body>
    <a href="/articles/x.pdf" data-test="download-pdf">Download PDF</a>
    <div class="c-article-supplementary__item" id="MOESM1">
      <a href="https://static-content.springer.com/esm/art%3A10.1038%2Fx/MediaObjects/41586_2021_1_MOESM1_ESM.pdf">Supplementary Information</a></div>
    <div class="c-article-supplementary__item" id="MOESM2">
      <a href="https://static-content.springer.com/esm/art%3A10.1038%2Fx/MediaObjects/41586_2021_1_MOESM2_ESM.pdf">Reporting Summary</a></div>
    <div class="c-article-supplementary__item" id="MOESM3">
      <a href="https://static-content.springer.com/esm/art%3A10.1038%2Fx/MediaObjects/41586_2021_1_MOESM3_ESM.mp4">Supplementary Video 1</a></div>
    <script type="application/json">{"files":["https://media.springernature.com/original/springer-static/esm/art%3A10.1038%2Fx/MediaObjects/41586_2021_1_MOESM2_ESM.pdf"]}</script>
    <ol class="c-article-references"><li><a href="https://example.org/other_si.pdf">Supplementary data of another paper</a></li></ol>
  </body></html>`;
  const found = links(html, "https://www.nature.com/articles/x", "10.1038/x");
  assert.deepEqual(
    found.map((l) => l.url.split("/").pop()),
    ["41586_2021_1_MOESM1_ESM.pdf"],
  );
});

test("RSC on Silverchair: supplement links without extension or DOI", () => {
  const html = `<html><body>
    <a href="/se/article-pdf/7/6/1502/8788200/d2se01519f.pdf">PDF</a>
    <div class="widget-ArticleDataSupplements" data-widget-name="ArticleDataSupplements">
      <h2 id="supplementary-data" class="section-title">Supplementary data</h2>
      <div class="dataSuppLink">
        <a class="openInAnotherWindow" data-doctype="dataSupplementDoc" target="_blank"
          href="/se/article-supplement/787932/pdf/d2se01519f1_suppl/"
          aria-label="Download Supplementary information (PDF)" rel="nofollow">
          <div class="caption"><div class="title">Supplementary information (PDF)</div></div></a>- pdf file
      </div></div>
  </body></html>`;
  const found = links(html, "https://pubs.rsc.org/se/article/7/6/1502/7148394/Suppressing", "10.1039/d2se01519f");
  assert.deepEqual(
    found.map((l) => [l.url, l.isPage]),
    [["https://pubs.rsc.org/se/article-supplement/787932/pdf/d2se01519f1_suppl/", false]],
  );
});

test("ACS / Wiley / PLOS / RSC style links", () => {
  const html = `<html><body><div id="supporting-information">
    <h2>Supporting Information</h2>
    <a href="/doi/suppl/10.1021/jacs.0c1/suppl_file/ja0c1_si_001.pdf">ja0c1_si_001.pdf (2 MB)</a>
    <a href="/doi/suppl/10.1021/jacs.0c1/suppl_file/ja0c1_si_002.cif">ja0c1_si_002.cif</a>
    <a href="https://onlinelibrary.wiley.com/action/downloadSupplement?doi=10.1002%2Fanie.1&file=anie1-sup-0001-misc_information.pdf">Supporting Information</a>
    <a href="/plosone/article/file?type=supplementary&id=10.1371/journal.pone.1.s001">S1 File</a>
    <a href="https://www.rsc.org/suppdata/c9/ee/c9ee1/c9ee1a1.pdf">Electronic supplementary information (ESI)</a>
    <a href="/doi/suppl/10.1021/jacs.0c1">View all Supporting Information</a>
  </div></body></html>`;
  const found = links(html, "https://pubs.acs.org/doi/10.1021/jacs.0c1", "10.1021/jacs.0c1");
  const urls = found.map((l) => l.url);
  assert.ok(urls.some((u) => u.endsWith("ja0c1_si_001.pdf")));
  assert.ok(!urls.some((u) => u.endsWith(".cif")));
  assert.ok(urls.some((u) => u.includes("downloadSupplement")));
  assert.ok(urls.some((u) => u.includes("type=supplementary")));
  assert.ok(urls.some((u) => u.includes("suppdata")));
  const page = found.find((l) => l.url.endsWith("/doi/suppl/10.1021/jacs.0c1"));
  assert.ok(page, "SI listing page is a candidate");
});

test("generic site: SI section with plain file names", () => {
  const html = `<html><body><section id="supplementary-material">
    <h3>Supplementary Material</h3>
    <a href="/files/abc123.docx">Table S1</a>
    <a href="/files/data.xlsx">Dataset S1</a>
  </section><a href="/files/other.pdf">Author guidelines</a></body></html>`;
  const found = links(html, "https://journal.example.org/article/42", "10.9/42");
  assert.deepEqual(found.map((l) => l.url), [
    "https://journal.example.org/files/abc123.docx",
  ]);
});

test("journal help pages are not mistaken for the article's SI", () => {
  const html = `<a href="/plosone/s/supporting-information">Supporting Information</a>`;
  assert.equal(
    links(html, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.1", "10.1371/journal.pone.1").length,
    0,
  );
});

test("Frontiers: extension in a middle path segment", () => {
  const url =
    "https://public-pages-files-2025.frontiersin.org/articles/5/file/Table_3.DOCX/5_supplementary-materials_tables_3_docx/1";
  assert.equal(extensionOf(url), "docx");
  const xlsx = url.replace("Table_3.DOCX", "Table_2.XLSX");
  const html = `<div class="SupplementaryMaterial"><a href="${url}">Download file</a><a href="${xlsx}">Download file</a></div>`;
  assert.deepEqual(links(html, "https://www.frontiersin.org/articles/10.3389/x/full", "10.3389/x").map((l) => l.url), [url]);
});

test("ScienceDirect: SI only present as attachment ids in JSON", () => {
  const html = `<script>window.__PRELOADED_STATE__ = {"attachments":[{"attachment-eid":"1-s2.0-S0013468620301234-mmc1.pdf"},{"attachment-eid":"1-s2.0-S0013468620301234-mmc2.docx"}]}</script>`;
  const found = links(html, "https://www.sciencedirect.com/science/article/pii/S0013468620301234");
  assert.deepEqual(found.map((l) => l.url).sort(), [
    "https://ars.els-cdn.com/content/image/1-s2.0-S0013468620301234-mmc1.pdf",
    "https://ars.els-cdn.com/content/image/1-s2.0-S0013468620301234-mmc2.docx",
  ]);
});

test("PLOS duplicate DOI links are dropped", () => {
  const html = `<div class="supplementary-material">
    <a href="/plosone/article/file?type=supplementary&id=10.1371/journal.pone.1.s001">S1 Fig</a>
    <a href="https://doi.org/10.1371/journal.pone.1.s001">https://doi.org/10.1371/journal.pone.1.s001</a></div>`;
  const found = links(html, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.1", "10.1371/journal.pone.1");
  assert.equal(found.length, 1);
  assert.ok(found[0].url.includes("type=supplementary"));
});

test("redirects, bot checks and alternative entry points", () => {
  const linkinghub = parseHTML(`<meta HTTP-EQUIV="REFRESH" content="2; url='/retrieve/articleSelectPrefsTemp?Redirect=https%3A%2F%2Fwww.sciencedirect.com%2Fscience%2Farticle%2Fpii%2FS0092867420302294&key=1'"/>`);
  assert.equal(
    findRedirect(linkinghub, "https://linkinghub.elsevier.com/retrieve/pii/S0092867420302294"),
    "https://www.sciencedirect.com/science/article/pii/S0092867420302294",
  );
  assert.deepEqual(
    alternativePages("https://linkinghub.elsevier.com/retrieve/pii/S0092867420302294"),
    ["https://www.sciencedirect.com/science/article/pii/S0092867420302294"],
  );
  assert.ok(looksLikeChallenge(parseHTML("<title>Just a moment...</title>")));
  assert.ok(!looksLikeChallenge(parseHTML("<title>A paper</title><p>text</p>")));
  const guesses = guessedFileURLs("10.1016/x", ["https://linkinghub.elsevier.com/retrieve/pii/S0140673620301835"]);
  assert.ok(guesses.includes("https://ars.els-cdn.com/content/image/1-s2.0-S0140673620301835-mmc1.pdf"));
});

test("transit pages: sign-on auto-submit form, not an article", () => {
  const sso = parseHTML(`<html><body><form method="post" action="https://pubs.rsc.org/ExternalAuthentication/OIDCLogin">
    <input type="hidden" name="code" value="81ED"/><noscript>&lt;button&gt;Click to continue&lt;/button&gt;</noscript></form>
    <script>window.addEventListener('load', function(){document.forms[0].submit();});</script></body></html>`);
  assert.equal(looksLikeTransit(sso), true);
  const article = parseHTML(`<html><body><h1>Title</h1><p>${"Abstract text. ".repeat(30)}</p></body></html>`);
  assert.equal(looksLikeTransit(article), false);
});
