// Find links to supplementary-information files on an article web page.
//
// This works on any publisher's page: it combines generic signals (link
// text, the section a link sits in, file names) with URL patterns of the
// big publishers, and also scans the raw HTML for SI file URLs that only
// appear inside embedded JSON (e.g. ScienceDirect). Pure DOM code, so it
// can be tested in Node.

export interface LinkCandidate {
  url: string;
  /** Link text or file name, used for logging and as a fallback title */
  label: string;
  /** Lower-case file extension, if the URL shows one */
  ext?: string;
  score: number;
  /**
   * True for links that look like an SI *listing page* rather than a file
   * (e.g. ACS "/doi/suppl/<doi>"); those are worth opening to find files.
   */
  isPage: boolean;
}

/** File types we can merge (PDF) or convert to PDF. */
export const DOCUMENT_EXTS = new Set([
  "pdf",
  "docx",
  "doc",
  "rtf",
  "odt",
  "zip",
]);

// Things that are never merged into a PDF.
const OTHER_EXTS = new Set([
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "txt",
  "json",
  "xml",
  "cif",
  "pdb",
  "mol",
  "mol2",
  "sdf",
  "xyz",
  "mp4",
  "mov",
  "avi",
  "wmv",
  "mpg",
  "mpeg",
  "webm",
  "mp3",
  "wav",
  "gif",
  "png",
  "jpg",
  "jpeg",
  "tif",
  "tiff",
  "svg",
  "eps",
  "ppt",
  "pptx",
  "gz",
  "tar",
  "7z",
  "rar",
  "fasta",
  "fa",
  "gb",
  "r",
  "py",
  "m",
  "ipynb",
  "bib",
  "ris",
  "enw",
  "css",
  "js",
]);

// URL fragments of publisher endpoints that serve SI *files*.
const FILE_URL = [
  /\/suppl_file\//i, // ACS, Science, PNAS, T&F, SAGE (Atypon)
  /\/suppdata\//i, // RSC, IOP
  /downloadSupplement/i, // Wiley, OUP
  /MOESM\d+/i, // Springer Nature
  /[-_/]ESM[._]/, // Springer Nature
  /static-content\.springer\.com\/esm\//i,
  /springer-static\/esm\//i,
  /-mmc\d+\./i, // Elsevier
  /_si_\d+/i, // ACS
  /\/media-\d+\./i, // bioRxiv, medRxiv
  /\.sapp\./i, // PNAS
  /\/supplemental\//i, // APS
  /type=supplementary/i, // PLOS
  /journal\.[a-z]+\.\d+\.s\d{3}/i, // PLOS file ids
  /\/bin\/[^/]+\.(pdf|docx?)$/i, // PMC
  /\/file\/(Data_Sheet|Table|Presentation|Image|Video)_\d+/i, // Frontiers
];

// Words in URLs that point at SI, files or listing pages alike.
const SI_PATH = [
  /\/doi\/suppl\//i,
  /supplementary[-_]?(material|information|data|file|info)/i,
  /supporting[-_]?info/i,
  /\/supplementary\//i,
  /\/supplements?\//i,
  /SupplementaryMaterials?/,
];
const STRONG_URL = [...FILE_URL, ...SI_PATH];

const WEAK_URL = [/ndownloader\/files\//i, /figshare\.com/i, /zenodo\.org/i];

const SI_TEXT =
  /supplementa(ry|l)|supporting\s+info|electronic\s+supplementary|\bESI\b|\bSI\b|\bSOM\b|appendix|extended\s+data|data\s+sheet|additional\s+file|supporting\s+material|source\s+data/i;

const SI_CONTAINER =
  /suppl|supporting[-_ ]?info|supporting[-_ ]?material|\besm\b|additional[-_ ]?file|supp[-_]|[-_]si[-_]|^si$|data[-_]?supplement/i;

const REF_CONTAINER =
  /(^|[-_ ])(ref|refs|references?|citations?|bibliography|bib|cited)([-_ ]|$)/i;

// Publisher paperwork that is listed with the SI but isn't SI.
const NOT_SI_TEXT =
  /reporting\s+summary|peer\s+review\s+file|transparent\s+peer\s+review|review\s+history|author\s+checklist|editorial\s+(process|history)|copyright|license|permissions/i;

const MAIN_PDF_TEXT =
  /^\s*(download\s+)?(full[\s-]*text\s+)?(article\s+)?(pdf|epdf|view pdf|download pdf|full text pdf|article pdf)\s*$/i;

const MAIN_PDF_URL =
  /\/doi\/(e?pdf|epdf|pdfdirect|reader)\/|\/pdf\/?($|\?)|\/pdfft|\/article-pdf\/|\.pdf\+html|type=printable|type=manuscript/i;

const CHALLENGE_TITLE =
  /just a moment|attention required|checking your browser|verify you are human|access denied|are you a robot|security check|captcha|client challenge|bot verification|please wait/i;

export function looksLikeChallenge(doc: Document): boolean {
  const title = doc.title || doc.querySelector("title")?.textContent || "";
  if (CHALLENGE_TITLE.test(title)) return true;
  const body = doc.body?.textContent?.slice(0, 2000) ?? "";
  return /cf-browser-verification|enable javascript and cookies to continue|cf_chl_/i.test(
    body + String(doc.documentElement?.innerHTML ?? "").slice(0, 5000),
  );
}

export function extensionOf(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  for (const key of ["file", "filename", "name", "id"]) {
    const v = u.searchParams.get(key);
    if (v) names.push(v);
  }
  // Last path segment first, then earlier ones: Frontiers serves
  // ".../file/Table_3.DOCX/<id>/1".
  names.push(...decodeSafe(u.pathname).split("/").filter(Boolean).reverse());
  for (const name of names) {
    const m = decodeSafe(name).match(/\.([a-z0-9]{2,5})$/i);
    if (m) {
      const ext = m[1].toLowerCase();
      if (DOCUMENT_EXTS.has(ext) || OTHER_EXTS.has(ext)) return ext;
    }
  }
  return undefined;
}

export function fileNameOf(url: string): string {
  try {
    const u = new URL(url);
    for (const key of ["file", "filename", "name"]) {
      const v = u.searchParams.get(key);
      if (v) return lastSegment(decodeSafe(v));
    }
    return lastSegment(decodeSafe(u.pathname)) || u.hostname;
  } catch {
    return lastSegment(url);
  }
}

function lastSegment(s: string): string {
  // Prefer a segment that looks like a file name (Frontiers puts it mid-path).
  const parts = s.split(/[/\\]/).filter(Boolean);
  const named = [...parts].reverse().find((p) => /\.[a-z0-9]{2,5}$/i.test(p));
  if (named) return named;
  return parts.pop() ?? s;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function elements(list: NodeListOf<Element>): Element[] {
  return Array.prototype.slice.call(list) as Element[];
}

function resolve(href: string, base: string): string | undefined {
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    return u.href;
  } catch {
    return undefined;
  }
}

function urlScore(url: string): number {
  if (STRONG_URL.some((p) => p.test(url))) return 5;
  if (WEAK_URL.some((p) => p.test(url))) return 2;
  return 0;
}

function ancestorSignals(el: Element): { si: boolean; refs: boolean } {
  let si = false;
  let refs = false;
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < 10; depth++) {
    const attrs = [
      node.id,
      node.getAttribute("class"),
      node.getAttribute("data-test"),
      node.getAttribute("data-title"),
      node.getAttribute("aria-labelledby"),
    ]
      .filter(Boolean)
      .join(" ");
    if (attrs) {
      if (REF_CONTAINER.test(attrs)) refs = true;
      if (SI_CONTAINER.test(attrs)) si = true;
    }
    // A heading right before the link's section, e.g. <h2>Supporting Information</h2>
    const heading = node.querySelector?.(":scope > h1, :scope > h2, :scope > h3, :scope > h4");
    if (heading && SI_TEXT.test(heading.textContent ?? "") && !refs) si = true;
    node = node.parentElement;
  }
  return { si, refs };
}

export interface ExtractOptions {
  /** The item's DOI, used to tell article pages apart from other pages */
  doi?: string;
  /** Raw HTML, scanned for SI URLs that only appear in embedded JSON */
  html?: string;
}

/**
 * Collect candidate SI links from an article page, best first.
 */
export function extractSupplementaryLinks(
  doc: Document,
  pageURL: string,
  options: ExtractOptions = {},
): LinkCandidate[] {
  const found = new Map<string, LinkCandidate>();
  const mainPDFs = new Set<string>();
  for (const meta of elements(
    doc.querySelectorAll('meta[name="citation_pdf_url"]'),
  )) {
    const u = resolve(meta.getAttribute("content") ?? "", pageURL);
    if (u) mainPDFs.add(u);
  }
  const page = resolve(pageURL, pageURL);
  const articleRoot = page
    ?.replace(/[?#].*$/, "")
    .replace(/\/(full|abstract|summary|fulltext|html|htm)\/?$/i, "")
    .replace(/\/$/, "");
  const doi = options.doi?.toLowerCase();
  // Links without a file name must belong to this article, so journal help
  // pages like "/s/supporting-information" are not followed.
  const belongsToArticle = (url: string) =>
    (doi && decodeSafe(url).toLowerCase().includes(doi)) ||
    (articleRoot && url.startsWith(articleRoot));

  const add = (c: LinkCandidate) => {
    const prev = found.get(c.url);
    if (!prev || prev.score < c.score) found.set(c.url, c);
  };

  // Visible links already judged on their text; the raw-HTML scan below
  // must not bring back ones rejected there (e.g. "Reporting Summary").
  const judged = new Set<string>();

  for (const a of elements(doc.querySelectorAll("a[href], [data-href]"))) {
    const href = a.getAttribute("href") || a.getAttribute("data-href") || "";
    if (!href || href.startsWith("#") || /^(javascript|mailto):/i.test(href)) {
      continue;
    }
    const url = resolve(href, pageURL);
    if (!url || url === page || mainPDFs.has(url)) continue;
    judged.add(url);

    const text = [
      a.textContent,
      a.getAttribute("title"),
      a.getAttribute("aria-label"),
      a.getAttribute("download"),
      a.getAttribute("data-track-action"),
      a.getAttribute("data-track-label"),
    ]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const ext = extensionOf(url);
    if (ext && OTHER_EXTS.has(ext)) continue;

    const { si, refs } = ancestorSignals(a);
    if (refs) continue;

    let score = urlScore(url);
    if (SI_TEXT.test(text)) score += 3;
    if (si) score += 4;
    if (ext && DOCUMENT_EXTS.has(ext)) score += 1;
    if (MAIN_PDF_URL.test(url) && urlScore(url) < 5) score -= 10;
    if (MAIN_PDF_TEXT.test(text) && urlScore(url) < 5) score -= 10;
    if (NOT_SI_TEXT.test(text)) score -= 10;
    const isFileEndpoint = FILE_URL.some((p) => p.test(url));
    if (!ext && !isFileEndpoint && !belongsToArticle(url)) continue;
    if (score < 5) continue;

    const label = (a.getAttribute("download") || text || fileNameOf(url))
      .slice(0, 200)
      .trim();
    add({ url, label, ext, score, isPage: !ext && !isFileEndpoint });
  }

  if (options.html) {
    for (const c of scanHTML(options.html, pageURL)) {
      if (!mainPDFs.has(c.url) && !judged.has(c.url)) add(c);
    }
  }

  // PLOS lists each file twice: the download link and the file's own DOI.
  const all = [...found.values()];
  const result = all.filter(
    (c) =>
      !(
        /^https?:\/\/(dx\.)?doi\.org\//i.test(c.url) &&
        all.some(
          (o) =>
            o !== c &&
            decodeSafe(o.url).includes(
              decodeSafe(c.url).replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""),
            ),
        )
      ),
  );
  return result.sort((a, b) => b.score - a.score);
}

/**
 * Well-known SI download URLs to try when the page itself shows none (they
 * are often rendered by scripts or behind a menu).
 */
export function guessedFileURLs(doi: string | undefined, seenURLs: string[]): string[] {
  const out: string[] = [];
  if (doi && /^10\.3390\//.test(doi)) {
    out.push(`https://www.mdpi.com/article/${doi}/s1`);
  }
  // Elsevier serves SI from its CDN under names built from the article PII.
  const pii = seenURLs
    .map((u) => u.match(/\/pii\/(S?[0-9X]{16,17})/i)?.[1])
    .find(Boolean);
  if (pii) {
    for (let n = 1; n <= 6; n++) {
      for (const ext of ["pdf", "docx", "doc"]) {
        out.push(`https://ars.els-cdn.com/content/image/1-s2.0-${pii.toUpperCase()}-mmc${n}.${ext}`);
      }
    }
  }
  return out;
}

// SI file URLs embedded anywhere in the page source (JSON, scripts, data-*).
const EMBEDDED_URL =
  /(?:https?:\/\/[a-z0-9.-]+)?\/[^\s"'<>\\()]+?\.(?:pdf|docx?|zip|rtf|odt)(?=[\s"'<>\\?#&)]|$)/gi;

// Elsevier only embeds the attachment id (eid) for ScienceDirect SI.
const ELSEVIER_EID = /1-s2\.0-[A-Z0-9]+-mmc\d+\.(?:pdf|docx?|zip)/gi;

export function scanHTML(html: string, pageURL: string): LinkCandidate[] {
  const text = html
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const out: LinkCandidate[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(EMBEDDED_URL)) {
    const url = resolve(m[0], pageURL);
    if (!url || seen.has(url) || urlScore(url) < 5) continue;
    if (MAIN_PDF_URL.test(url) && !STRONG_URL.some((p) => p.test(url))) continue;
    seen.add(url);
    out.push({
      url,
      label: fileNameOf(url),
      ext: extensionOf(url),
      score: 5,
      isPage: false,
    });
  }

  for (const m of text.matchAll(ELSEVIER_EID)) {
    const url = `https://ars.els-cdn.com/content/image/${m[0]}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      label: m[0],
      ext: extensionOf(url),
      score: 6,
      isPage: false,
    });
  }
  return out;
}

/** Follow-up URL for pages that only redirect via meta refresh or a form. */
export function findRedirect(doc: Document, pageURL: string): string | undefined {
  const refresh = elements(doc.querySelectorAll("meta"))
    .map((m) => Array.prototype.slice.call(m.attributes) as Attr[])
    .find((attrs) =>
      attrs.some(
        (a) =>
          a.name.toLowerCase() === "http-equiv" &&
          a.value.toLowerCase() === "refresh",
      ),
    )
    ?.find((a) => a.name.toLowerCase() === "content")?.value;
  const m = refresh?.match(/url\s*=\s*['"]?([^'"]+)/i);
  if (m) {
    // Elsevier's linkinghub wraps the real target in a Redirect= parameter.
    const inner = m[1].match(/[?&]Redirect=([^&]+)/i);
    return resolve(inner ? decodeSafe(inner[1]) : m[1], pageURL);
  }
  const input = doc
    .querySelector('input[name="redirectURL"]')
    ?.getAttribute("value");
  if (input) return resolve(decodeSafe(input), pageURL);
  return undefined;
}

/** Article page candidates that work better than what a DOI resolves to. */
export function alternativePages(pageURL: string): string[] {
  const pii = pageURL.match(/\/retrieve\/pii\/([A-Z0-9]+)/i);
  if (pii) return [`https://www.sciencedirect.com/science/article/pii/${pii[1]}`];
  return [];
}
