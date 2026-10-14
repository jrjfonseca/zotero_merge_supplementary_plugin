// Network access inside Zotero: plain HTTP first, Zotero's hidden browser
// (runs scripts, passes bot checks, uses the user's cookies) as fallback.

import { getHiddenBrowserClass, localBytes } from "../../utils/gecko";
import type { Download, Net, Page, RepositoryFile } from "./discover";
import { parseJATSCaptions } from "./files";
import { looksLikeChallenge } from "./links";

const MAX_FILE_BYTES = 200 * 1024 * 1024;

export function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

async function request(
  url: string,
  responseType: "text" | "arraybuffer",
  headers: Record<string, string> = {},
  timeout = 30000,
): Promise<XMLHttpRequest | null> {
  try {
    return (await (Zotero.HTTP as any).request("GET", url, {
      responseType,
      headers,
      successCodes: false,
      timeout,
      errorDelayMax: 0,
    })) as XMLHttpRequest;
  } catch (e) {
    ztoolkit.log(`GET ${url} failed`, e);
    return null;
  }
}

export async function fetchPageHTTP(url: string): Promise<Page | null> {
  const xhr = await request(url, "text", {
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  });
  if (!xhr) return null;
  const html = String(xhr.responseText ?? "");
  return {
    url: xhr.responseURL || url,
    html,
    doc: parse(html),
    status: xhr.status,
    viaBrowser: false,
  };
}

/**
 * Load a page in a hidden browser, waiting for bot checks (Cloudflare etc.)
 * to clear and for scripts to render the page.
 */
export async function fetchPageBrowser(url: string): Promise<Page | null> {
  let browser: any;
  try {
    const HiddenBrowser = await getHiddenBrowserClass();
    browser = new HiddenBrowser();
    if (!(await browser.load(url))) return null;
    const deadline = Date.now() + 30000;
    let doc: Document;
    for (;;) {
      if (typeof browser.waitForDocument === "function") {
        await browser.waitForDocument({ allowInteractiveAfter: 3000 });
      }
      // Give client-side rendering a moment to fill in the SI section.
      await Zotero.Promise.delay(2500);
      doc = await browser.getDocument();
      if (!looksLikeChallenge(doc) || Date.now() > deadline) break;
      await Zotero.Promise.delay(2500);
    }
    const html = String(doc.documentElement?.outerHTML ?? "");
    return {
      url: browser.currentURI?.spec || url,
      html,
      doc: parse(html),
      status: looksLikeChallenge(doc) ? 403 : 200,
      viaBrowser: true,
    };
  } catch (e) {
    ztoolkit.log(`Hidden browser could not load ${url}`, e);
    return null;
  } finally {
    browser?.destroy();
  }
}

function fileNameFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = header.match(/filename\*\s*=\s*[^']*'[^']*'([^;]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // fall through
    }
  }
  const plain = header.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain?.[1].trim();
}

export async function downloadFile(
  url: string,
  referrer?: string,
): Promise<Download | null> {
  const headers: Record<string, string> = {};
  if (referrer) headers.Referer = referrer;
  // Generous: Europe PMC builds its ZIP on the fly and can take minutes.
  const xhr = await request(url, "arraybuffer", headers, 300000);
  if (!xhr) return null;
  const finalURL = xhr.responseURL || url;
  const buffer = xhr.response as ArrayBuffer | null;
  if (
    xhr.status >= 400 ||
    !buffer ||
    buffer.byteLength === 0 ||
    buffer.byteLength > MAX_FILE_BYTES
  ) {
    ztoolkit.log(`Download ${url}: HTTP ${xhr.status}`);
    return { url: finalURL, status: xhr.status };
  }
  return {
    url: finalURL,
    status: xhr.status,
    bytes: localBytes(buffer),
    name: fileNameFromHeader(xhr.getResponseHeader("Content-Disposition")),
  };
}

/**
 * Supplementary files of open-access articles mirrored in Europe PMC, as one
 * ZIP archive. Works for any publisher whose article is in PMC.
 */
export async function downloadEuropePMCSupplements(
  doi: string,
): Promise<Download | null> {
  const query = encodeURIComponent(`DOI:"${doi}"`);
  const search = await request(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${query}&resultType=lite&format=json`,
    "text",
  );
  if (!search || search.status !== 200) return null;
  let hit: any;
  try {
    const json = JSON.parse(search.responseText ?? "");
    hit = json?.resultList?.result?.find((r: any) => r.pmcid);
  } catch {
    return null;
  }
  const pmcid: string | undefined = hit?.pmcid;
  if (!pmcid) return null;
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/supplementaryFiles`;
  // Europe PMC only serves the files of open-access articles.
  if (hit.hasSuppl === "N" || hit.isOpenAccess !== "Y") {
    return { url, status: 404, pmcid };
  }
  const zip = await downloadFile(url);
  if (!zip) return { url, status: 0, pmcid };
  zip.pmcid = pmcid;
  if (zip.bytes) zip.captions = await europePMCCaptions(pmcid);
  return zip;
}

/** File name -> caption of each supplementary file, from the article XML. */
async function europePMCCaptions(pmcid: string): Promise<Record<string, string>> {
  const xhr = await request(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
    "text",
  );
  return xhr?.status === 200 ? parseJATSCaptions(String(xhr.responseText ?? "")) : {};
}

/** Files deposited on Figshare for the article with this DOI. */
export async function figshareFiles(doi: string): Promise<RepositoryFile[]> {
  try {
    const search = await (Zotero.HTTP as any).request(
      "POST",
      "https://api.figshare.com/v2/articles/search",
      {
        body: JSON.stringify({ search_for: `:resource_doi: ${doi}`, page_size: 20 }),
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        successCodes: false,
        timeout: 30000,
      },
    );
    if (search.status !== 200 || !Array.isArray(search.response)) return [];
    const out: RepositoryFile[] = [];
    for (const record of search.response) {
      if (String(record.resource_doi ?? "").toLowerCase() !== doi.toLowerCase()) continue;
      const detail = await (Zotero.HTTP as any).request(
        "GET",
        `https://api.figshare.com/v2/articles/${record.id}`,
        { responseType: "json", successCodes: false, timeout: 30000 },
      );
      for (const f of detail.response?.files ?? []) {
        if (DOC_NAME.test(f.name ?? "")) {
          out.push({ url: f.download_url, name: f.name, title: record.title });
        }
      }
    }
    return out;
  } catch (e) {
    ztoolkit.log("Figshare lookup failed", e);
    return [];
  }
}

const DOC_NAME = /\.(pdf|docx?|odt|rtf|pptx?|odp|zip)$/i;

export const zoteroNet: Net = {
  fetchPage: fetchPageHTTP,
  renderPage: fetchPageBrowser,
  download: downloadFile,
  europePMC: downloadEuropePMCSupplements,
  figshare: figshareFiles,
  parseHTML: parse,
  sleep: (ms) => Zotero.Promise.delay(ms),
};
