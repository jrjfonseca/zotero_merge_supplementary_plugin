// Find and download an article's supplementary files from the web.
//
// Network access is injected (see Net), so the same code runs inside Zotero
// and in Node tests against real publisher sites.

import {
  extractDocumentsFromZip,
  isConvertible,
  sameBytes,
  sniff,
  type FileType,
  type NamedFile,
} from "./files";
import {
  alternativePages,
  extractSupplementaryLinks,
  fileNameOf,
  findRedirect,
  guessedFileURLs,
  looksLikeChallenge,
  NOT_SI_TEXT,
  type LinkCandidate,
} from "./links";

export interface Page {
  url: string;
  html: string;
  doc: Document;
  status: number;
  viaBrowser: boolean;
}

export interface Download {
  url: string;
  status: number;
  /** Empty when the request failed */
  bytes?: Uint8Array;
  name?: string;
  /** For archives: file name -> caption, when the source describes them */
  captions?: Record<string, string>;
  /** Europe PMC: the article's PubMed Central id, when it has one */
  pmcid?: string;
}

export interface RepositoryFile {
  url: string;
  name: string;
  /** Title of the repository record, e.g. "Supplementary Information" */
  title?: string;
}

export interface Net {
  /** Plain HTTP GET of an HTML page */
  fetchPage(url: string): Promise<Page | null>;
  /** Load a page in a real browser engine (scripts, bot checks, cookies) */
  renderPage(url: string): Promise<Page | null>;
  download(url: string, referrer?: string): Promise<Download | null>;
  /**
   * Europe PMC's ZIP of supplementary files for an open-access article,
   * with each file's caption when available
   */
  europePMC(doi: string): Promise<Download | null>;
  /** Files deposited on Figshare for the article with this DOI */
  figshare?(doi: string): Promise<RepositoryFile[]>;
  /** Wait (for retrying temporary server errors) */
  sleep?(ms: number): Promise<void>;
  parseHTML(html: string): Document;
}

export type Report = (key: string, args?: Record<string, unknown>) => void;

export interface FoundFile extends NamedFile {
  type: FileType;
  source: string;
}

const MAX_PAGES = 6;
const DOC_FILE = /\.(pdf|docx?|odt|rtf|pptx?|odp|zip)$/i;
// Statuses worth one more try: bot checks, rate limits, temporary errors.
const REFUSED = new Set([401, 403, 429, 502, 503, 504]);
const MAX_FILES = 20;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function originOf(url: string): string | undefined {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return undefined;
  }
}

export class Discovery {
  private net: Net;
  private report: Report;
  private doi?: string;
  /** Pages already opened in the browser engine (bot checks cleared) */
  private rendered = new Set<string>();
  /** Every page URL seen, including redirects and blocked pages */
  private seen: string[] = [];

  constructor(net: Net, report: Report, doi?: string) {
    this.net = net;
    this.report = report;
    this.doi = doi;
  }

  async loadArticlePage(url: string): Promise<Page | null> {
    let page = await this.net.fetchPage(url);
    if (page) this.seen.push(page.url);
    // Follow meta-refresh / form redirects (e.g. Elsevier's linkinghub).
    for (let hops = 0; page && page.status < 400 && hops < 3; hops++) {
      const next = findRedirect(page.doc, page.url);
      if (!next || next === page.url) break;
      this.seen.push(next);
      page = await this.net.fetchPage(next);
      if (page) this.seen.push(page.url);
    }
    const blocked = !page || page.status >= 400 || looksLikeChallenge(page.doc);
    const empty =
      !blocked &&
      extractSupplementaryLinks(page!.doc, page!.url, {
        doi: this.doi,
        html: page!.html,
      }).length === 0;
    if (blocked || empty) {
      // Bot-protected or script-rendered: let a real browser engine try.
      const target = page?.url ?? url;
      const rendered = await this.net.renderPage(target);
      this.rendered.add(target);
      if (rendered) this.rendered.add(rendered.url);
      if (rendered && rendered.status < 400) return rendered;
    }
    return page && page.status < 400 ? page : null;
  }

  async findCandidates(
    startURLs: string[],
  ): Promise<{ files: LinkCandidate[]; referrer?: string }> {
    const queue = [...startURLs];
    const visited = new Set<string>();
    const files = new Map<string, LinkCandidate>();
    let referrer: string | undefined;
    let pagesFollowed = 0;

    while (queue.length && visited.size < MAX_PAGES) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);
      this.report("fetch-progress-page", { host: hostOf(url) });

      const page = await this.loadArticlePage(url);
      // Even a blocked page can reveal a better entry point (Elsevier PII).
      for (const alt of this.seen.flatMap(alternativePages)) {
        if (!visited.has(alt) && !queue.includes(alt)) queue.push(alt);
      }
      if (!page) continue;
      visited.add(page.url);
      referrer ??= page.url;

      for (const c of extractSupplementaryLinks(page.doc, page.url, {
        doi: this.doi,
        html: page.html,
      })) {
        if (c.isPage) {
          if (pagesFollowed < 2 && !visited.has(c.url)) {
            pagesFollowed++;
            queue.unshift(c.url);
          }
        } else if (!files.has(c.url)) {
          files.set(c.url, c);
        }
      }
      // The article page listed its SI: no need to try other entry points.
      if (files.size > 0 && pagesFollowed === 0) break;
    }

    if (files.size === 0) {
      for (const url of guessedFileURLs(this.doi, this.seen)) {
        files.set(url, { url, label: fileNameOf(url), score: 1, isPage: false });
      }
    }
    return { files: [...files.values()].slice(0, MAX_FILES), referrer };
  }

  /** Download candidates, unpack archives, follow HTML landing pages once. */
  async downloadCandidates(
    candidates: LinkCandidate[],
    referrer: string | undefined,
    depth = 0,
  ): Promise<FoundFile[]> {
    const found: FoundFile[] = [];
    const refused: LinkCandidate[] = [];

    const handle = async (c: LinkCandidate, dl: Download) => {
      const bytes = dl.bytes!;
      const type = sniff(bytes);
      const name = dl.name || fileNameOf(dl.url) || c.label;
      if (type === "zip") {
        for (const f of extractDocumentsFromZip(bytes)) {
          const t = sniff(f.bytes);
          if (t === "pdf" || isConvertible(t)) {
            found.push({ ...f, type: t, source: c.url });
          }
        }
      } else if (type === "pdf" || isConvertible(type)) {
        found.push({ name, bytes, type, source: c.url });
      } else if (type === "html" && depth === 0) {
        // An SI landing page (e.g. "/doi/suppl/<doi>") or a download page.
        const html = new TextDecoder().decode(bytes);
        const doc = this.net.parseHTML(html);
        if (looksLikeChallenge(doc)) {
          refused.push(c);
          return;
        }
        const inner = extractSupplementaryLinks(doc, dl.url, {
          doi: this.doi,
          html,
        }).filter((l) => !l.isPage && l.url !== c.url);
        found.push(
          ...(await this.downloadCandidates(inner.slice(0, MAX_FILES), dl.url, 1)),
        );
      }
    };

    for (const [i, c] of candidates.entries()) {
      this.report("fetch-progress-download", {
        current: i + 1,
        total: candidates.length,
      });
      const dl = await this.net.download(c.url, referrer);
      if (dl?.bytes) await handle(c, dl);
      else if (dl && REFUSED.has(dl.status)) refused.push(c);
    }

    // Bot check on the file host: pass it once in the browser engine (which
    // shares cookies with plain requests), then try those files again. Also
    // gives temporary errors ("try again in 30 seconds") time to clear.
    // Files on another host than the article (e.g. a CDN) need their own
    // check passed: open that host's home page.
    if (refused.length) {
      const toOpen = referrer ? [referrer] : [];
      for (const c of refused) {
        const home = originOf(c.url);
        if (home && !toOpen.some((u) => hostOf(u) === hostOf(home))) toOpen.push(home);
      }
      let opened = false;
      for (const url of toOpen) {
        if ([...this.rendered].some((r) => hostOf(r) === hostOf(url))) continue;
        this.rendered.add(url);
        await this.net.renderPage(url);
        opened = true;
      }
      if (!opened) await this.net.sleep?.(5000);
      const retry = refused.splice(0);
      for (const c of retry) {
        const dl = await this.net.download(c.url, referrer);
        if (dl?.bytes) await handle(c, dl);
      }
    }
    return found;
  }

  /**
   * Everything in one go. Sources, until one yields documents:
   * 1. the publisher's article page (and SI pages/files it links to);
   * 2. Figshare, where many publishers mirror SI (ACS, T&F, PLOS, SAGE…);
   * 3. Europe PMC's SI archive for open-access articles;
   * 4. the PubMed Central article page (e.g. author manuscripts).
   */
  async run(startURLs: string[]): Promise<FoundFile[]> {
    const { files, referrer } = await this.findCandidates(startURLs);
    let found = files.length ? await this.downloadCandidates(files, referrer) : [];

    if (found.length === 0 && this.doi && this.net.figshare) {
      this.report("fetch-progress-figshare");
      const deposited = (await this.net.figshare(this.doi)).filter(
        (f) => !NOT_SI_TEXT.test(`${f.title ?? ""} ${f.name}`),
      );
      found = await this.downloadCandidates(
        deposited.slice(0, MAX_FILES).map((f) => ({
          url: f.url,
          label: f.name,
          score: 5,
          isPage: false,
        })),
        undefined,
        1,
      );
      // Figshare download links have no file name; keep the deposited one.
      for (const f of found) {
        const dep = deposited.find((d) => d.url === f.source);
        if (dep && !/\.[a-z0-9]{2,5}$/i.test(f.name)) f.name = dep.name;
      }
    }

    let pmcid: string | undefined;
    if (found.length === 0 && this.doi) {
      this.report("fetch-progress-pmc");
      const zip = await this.net.europePMC(this.doi);
      pmcid = zip?.pmcid;
      if (zip?.bytes && sniff(zip.bytes) === "zip") {
        const captions = zip.captions ?? {};
        found = extractDocumentsFromZip(zip.bytes)
          .map((f) => ({ ...f, type: sniff(f.bytes), source: zip.url }))
          .filter((f) => f.type === "pdf" || isConvertible(f.type))
          // Drop "Reporting Summary", "Peer Review File" and the like.
          .filter((f) => !NOT_SI_TEXT.test(captions[f.name] ?? ""));
      }
      // Author manuscripts: the archive can lack SI files that the article
      // XML lists; PMC serves those next to the article.
      if (found.length === 0 && pmcid && zip?.captions) {
        const listed = Object.entries(zip.captions)
          .filter(([name, caption]) => DOC_FILE.test(name) && !NOT_SI_TEXT.test(caption))
          .map(([name]) => ({
            url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/bin/${encodeURIComponent(name)}`,
            label: name,
            score: 5,
            isPage: false,
          }));
        if (listed.length) found = await this.downloadCandidates(listed, undefined, 1);
      }
    }

    if (found.length === 0 && pmcid) {
      const pmc = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
      const { files: pmcFiles, referrer: pmcRef } = await this.findCandidates([pmc]);
      if (pmcFiles.length) found = await this.downloadCandidates(pmcFiles, pmcRef);
    }

    // Same file linked twice (e.g. "view" and "download" links).
    const unique: FoundFile[] = [];
    for (const f of found) {
      if (!unique.some((u) => sameBytes(u.bytes, f.bytes))) unique.push(f);
    }
    return unique;
  }
}

/** Where to start looking for an item: its URL, then its DOI. */
export function startURLs(doi?: string, itemURL?: string): string[] {
  const urls: string[] = [];
  if (itemURL && /^https?:\/\//i.test(itemURL) && !/\.pdf($|\?)/i.test(itemURL)) {
    urls.push(itemURL);
  }
  if (doi) urls.push(`https://doi.org/${encodeURI(doi)}`);
  return urls;
}
