// Pure scoring logic for telling a main article PDF apart from its
// supplementary-information PDFs. Nothing in here touches Zotero, so it can be
// unit-tested in Node (see test/detect.test.ts).

export interface CandidateSignals {
  /** Attachment title as shown in Zotero */
  title: string;
  /** File name on disk (may be empty) */
  filename: string;
  /** Text of the first page(s), if content detection is enabled/available */
  text?: string;
  /** Parent item's title, used to ignore keywords that come from it */
  parentTitle?: string;
  /** Parent item's DOI, if any */
  parentDOI?: string;
}

export interface ScoredCandidate<T> {
  ref: T;
  /** > 0 means "looks supplementary", < 0 means "looks like the main article" */
  score: number;
  reasons: string[];
}

export type Classification<T> =
  | {
      confident: true;
      main: ScoredCandidate<T>;
      supplementary: ScoredCandidate<T>[];
      /** PDFs that look like neither; they are left alone */
      ignored: ScoredCandidate<T>[];
    }
  | {
      confident: false;
      reason: string;
      /** Best guesses, used to pre-fill the manual picker */
      main?: ScoredCandidate<T>;
      supplementary: ScoredCandidate<T>[];
    };

/** Minimum score for a PDF to count as supplementary. */
export const SUPP_THRESHOLD = 3;
/** Minimum score gap between the main PDF and every supplementary PDF. */
export const MIN_MARGIN = 4;

// Keywords that mark a title or file name as supplementary material.
const NAME_PATTERNS: RegExp[] = [
  /supplementa(l|ry)/i,
  /supporting[\s._-]*info/i,
  /support(ing)?[\s._-]*mat/i,
  /(^|[^a-z])(sup|supp|suppl|supps?\d+)([^a-z]|$)/i,
  /(^|[^A-Za-z])(E?SI|SM|SOM)\d*([^A-Za-z]|$)/, // SI, ESI, SM, SOM (upper case)
  /[-_.](si|esi|sm|som)([-_.\d]|$)/, // ACS "ja1c01234_si_001", Science "..._sm"
  /(^|[^a-z])sapp([^a-z]|$)/i, // PNAS "pnas.2012345118.sapp"
  /(^|[^a-z])(moesm\d+|esm)([^a-z]|$)/i, // Springer "..._MOESM1_ESM"
  /appendix/i,
  /extended[\s._-]*data/i,
  /(^|[^a-z])mmc\d+([^a-z]|$)/i, // Elsevier "1-s2.0-...-mmc1"
  /(^|[^a-z])sup-\d+/i, // Wiley "...-sup-0001-..."
];

// Titles that Zotero translators / "Find Available PDF" give the article itself.
const MAIN_TITLE_PATTERNS: RegExp[] = [
  /^full[\s-]*text( pdf)?$/i,
  /^pdf$/i,
  /^(accepted|submitted|published) version$/i,
  /^(preprint|postprint|author manuscript)( pdf)?$/i,
  /^(article|main( text)?|manuscript)( pdf)?$/i,
];

// Headings that open a supplementary document.
const TEXT_HEADING =
  /\b(supporting\s+information|supplementa(?:ry|l)\s+(?:information|materials?|data|figures?|methods|notes|text|tables?|appendix)|electronic\s+supplementary\s+(?:information|material)|supplementary\s+online\s+material|extended\s+data)\b/gi;

// Phrases right after a heading match that show it is only a pointer to the
// SI from inside the main article ("Supporting Information is available...").
const POINTER_CONTEXT =
  /^.{0,80}?(available|online version|accompan|free of charge|see\b)/is;

// Fingerprints of publisher article headers that list "Supporting Information"
// as a link (ACS puts it next to "Article Recommendations" on page 1).
const ARTICLE_HEADER = /article\s+recommendations|read\s+online|cite\s+this:/i;

// Numbered supplementary labels, e.g. "Figure S1", "Table S3", "Scheme S2".
const S_LABEL =
  /\b(?:fig(?:ure)?s?|tables?|schemes?|notes?|equations?|eqs?|sections?)\.?\s*S\d+/gi;

function tokens(s: string): string[] {
  return s.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

/**
 * Drop words that also appear in the parent item's title, so that a paper
 * called e.g. "An appendix to ..." doesn't make every renamed PDF look
 * supplementary.
 */
function stripParentTitle(name: string, parentTitle?: string): string {
  if (!parentTitle) return name;
  const words = new Set(tokens(parentTitle).map((t) => t.toLowerCase()));
  return name
    .split(/([^A-Za-z0-9]+)/)
    .map((part) => (words.has(part.toLowerCase()) ? "" : part))
    .join("");
}

export function matchesSupplementaryName(
  name: string,
  parentTitle?: string,
): boolean {
  const base = stripParentTitle(name.replace(/\.pdf$/i, ""), parentTitle);
  return NAME_PATTERNS.some((p) => p.test(base));
}

export function matchesMainTitle(title: string): boolean {
  const t = title.trim();
  return MAIN_TITLE_PATTERNS.some((p) => p.test(t));
}

export function countSLabels(text: string): number {
  return text.match(S_LABEL)?.length ?? 0;
}

export function hasSupplementaryHeading(text: string): boolean {
  // Only the opening of the document counts as a heading.
  const head = text.slice(0, 800);
  if (ARTICLE_HEADER.test(head)) return false;
  for (const m of head.matchAll(TEXT_HEADING)) {
    const after = head.slice((m.index ?? 0) + m[0].length);
    if (!POINTER_CONTEXT.test(after)) return true;
  }
  return false;
}

export function scoreCandidate<T>(
  ref: T,
  s: CandidateSignals,
): ScoredCandidate<T> {
  let score = 0;
  const reasons: string[] = [];

  if (matchesSupplementaryName(s.title, s.parentTitle)) {
    score += 5;
    reasons.push("title mentions supplementary material");
  } else if (matchesMainTitle(s.title)) {
    score -= 3;
    reasons.push(`"${s.title}" is a typical main-article title`);
  }

  if (s.filename && matchesSupplementaryName(s.filename, s.parentTitle)) {
    score += 4;
    reasons.push("file name mentions supplementary material");
  }

  if (s.text) {
    if (hasSupplementaryHeading(s.text)) {
      score += 4;
      reasons.push("starts with a supplementary-information heading");
    }

    const sLabels = countSLabels(s.text);
    if (sLabels >= 5) {
      score += 2;
      reasons.push(`${sLabels} "Figure S#"-style labels`);
    }

    if (/\babstract\b/i.test(s.text.slice(0, 3000))) {
      score -= 1;
      reasons.push("has an abstract");
    }

    if (s.parentDOI && s.text.toLowerCase().includes(s.parentDOI.toLowerCase())) {
      score -= 1;
      reasons.push("contains the item's DOI");
    }
  }

  return { ref, score, reasons };
}

export interface ClassifyOptions<T> {
  /** Used to order several supplementary files (natural sort). */
  sortName?: (c: ScoredCandidate<T>) => string;
  /** Tie-breaker for ordering: earlier first. */
  dateAdded?: (c: ScoredCandidate<T>) => number;
}

/**
 * Decide which PDF is the main article and which ones are supplementary.
 *
 * Confident only when exactly one PDF is clearly the article and every other
 * PDF that gets merged is clearly supplementary, with a safety margin between
 * them. That keeps duplicates (e.g. a preprint next to the published version)
 * and borderline cases from ever being merged without asking.
 */
export function classify<T>(
  candidates: ScoredCandidate<T>[],
  opts: ClassifyOptions<T> = {},
): Classification<T> {
  if (candidates.length < 2) {
    return {
      confident: false,
      reason: `need at least 2 PDFs, found ${candidates.length}`,
      supplementary: [],
    };
  }

  const supp = sortSupplementary(
    candidates.filter((c) => c.score >= SUPP_THRESHOLD),
    opts,
  );
  const rest = [...candidates.filter((c) => c.score < SUPP_THRESHOLD)].sort(
    (a, b) => a.score - b.score,
  );
  const bestMain = [...candidates].sort((a, b) => a.score - b.score)[0];

  if (supp.length === 0) {
    return {
      confident: false,
      reason: "no PDF looks like supplementary information",
      main: bestMain,
      supplementary: sortSupplementary(
        candidates.filter((c) => c !== bestMain),
        opts,
      ),
    };
  }

  if (rest.length === 0) {
    return {
      confident: false,
      reason: "every PDF looks like supplementary information",
      main: bestMain,
      supplementary: supp.filter((c) => c !== bestMain),
    };
  }

  const main = rest[0];
  const ignored = rest.slice(1);

  if (ignored.length > 0 && ignored[0].score - main.score < 3) {
    return {
      confident: false,
      reason: "more than one PDF could be the main article",
      main,
      supplementary: supp,
    };
  }

  const weakest = Math.min(...supp.map((c) => c.score));
  if (weakest - main.score < MIN_MARGIN) {
    return {
      confident: false,
      reason: "main and supplementary PDFs are too similar to tell apart",
      main,
      supplementary: supp,
    };
  }

  return { confident: true, main, supplementary: supp, ignored };
}

function sortSupplementary<T>(
  cs: ScoredCandidate<T>[],
  opts: ClassifyOptions<T>,
): ScoredCandidate<T>[] {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  return [...cs].sort((a, b) => {
    const byName = collator.compare(
      opts.sortName?.(a) ?? "",
      opts.sortName?.(b) ?? "",
    );
    if (byName !== 0) return byName;
    return (opts.dateAdded?.(a) ?? 0) - (opts.dateAdded?.(b) ?? 0);
  });
}
