// DOCX -> HTML (mammoth) and a plain pdf-lib renderer for that HTML, used
// as the last-resort converter when neither LibreOffice nor Zotero's print
// engine is available. No Zotero APIs, so it can be tested in Node.

import mammoth from "mammoth";
import {
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  StandardFonts,
  rgb,
} from "pdf-lib";

const STYLE = `
@page { margin: 16mm 15mm; }
html { font-family: "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
  font-size: 10.5pt; line-height: 1.35; color: #000; background: #fff; }
h1 { font-size: 16pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; }
h4, h5, h6 { font-size: 11pt; }
p { margin: 0 0 6pt; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 6pt 0 10pt; font-size: 8.5pt;
  max-width: 100%; }
td, th { border: 0.5pt solid #777; padding: 2pt 4pt; vertical-align: top; }
td p, th p { margin: 0; }
pre, code { font-family: "Courier New", monospace; font-size: 8.5pt;
  white-space: pre-wrap; }
`;

function escapeHTML(s: string): string {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Convert a DOCX file to a standalone, script-free HTML document. */
export async function docxToHTML(
  bytes: Uint8Array,
  title: string,
): Promise<string> {
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  // The browser build of mammoth reads `arrayBuffer`, the Node one `buffer`.
  const result = await mammoth.convertToHtml({
    arrayBuffer,
    buffer: bytes,
  } as any);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHTML(title)}</title>
<style>${STYLE}</style></head>
<body>${result.value}</body></html>`;
}

// ---------------------------------------------------------------------------
// Fallback renderer

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - 2 * MARGIN;

// Characters outside the standard PDF fonts' WinAnsi set.
const REPLACEMENTS: Record<string, string> = {
  "−": "-",
  "‐": "-",
  "‑": "-",
  "≤": "<=",
  "≥": ">=",
  "≠": "!=",
  "≈": "~",
  "→": "->",
  "←": "<-",
  "↔": "<->",
  "∞": "inf",
  " ": " ",
  " ": " ",
  " ": " ",
  "μ": "µ",
};
const GREEK = "αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ";
const GREEK_NAMES = [
  "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "omicron", "pi", "rho",
  "sigma", "tau", "upsilon", "phi", "chi", "psi", "omega",
];
const SUBSUP = "₀₁₂₃₄₅₆₇₈₉⁰⁴⁵⁶⁷⁸⁹";
const SUBSUP_PLAIN = "01234567890456789";

class TextSanitizer {
  private supported: Set<number>;
  constructor(font: PDFFont) {
    this.supported = new Set(font.getCharacterSet());
  }
  clean(text: string): string {
    let out = "";
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (this.supported.has(cp)) {
        out += ch;
        continue;
      }
      const g = GREEK.indexOf(ch);
      if (g >= 0) {
        const name = GREEK_NAMES[g % 24];
        out += g >= 24 ? name[0].toUpperCase() + name.slice(1) : name;
        continue;
      }
      const s = SUBSUP.indexOf(ch);
      if (s >= 0) {
        out += SUBSUP_PLAIN[s];
        continue;
      }
      const r = REPLACEMENTS[ch] ?? ch.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
      out += [...r].every((c) => this.supported.has(c.codePointAt(0)!)) ? r : "?";
    }
    return out;
  }
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
  mono: PDFFont;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

class Layout {
  page!: PDFPage;
  y = 0;
  private pdf: PDFDocument;
  private fonts: Fonts;
  private sanitize: TextSanitizer;

  constructor(pdf: PDFDocument, fonts: Fonts, sanitize: TextSanitizer) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.sanitize = sanitize;
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  font(run: { bold: boolean; italic: boolean }): PDFFont {
    const f = this.fonts;
    if (run.bold && run.italic) return f.boldItalic;
    if (run.bold) return f.bold;
    if (run.italic) return f.italic;
    return f.regular;
  }

  /** Word-wrap runs into lines of (font, text) pieces. */
  wrap(runs: Run[], size: number, width: number) {
    type Piece = { font: PDFFont; text: string; width: number };
    const lines: Piece[][] = [[]];
    let lineWidth = 0;
    for (const run of runs) {
      const font = this.font(run);
      const parts = this.sanitize.clean(run.text).split(/(\s+|\n)/);
      for (const part of parts) {
        if (!part) continue;
        if (part === "\n") {
          lines.push([]);
          lineWidth = 0;
          continue;
        }
        const isSpace = /^\s+$/.test(part);
        const text = isSpace ? " " : part;
        let w = font.widthOfTextAtSize(text, size);
        if (isSpace && lineWidth === 0) continue;
        if (!isSpace && lineWidth + w > width && lineWidth > 0) {
          lines.push([]);
          lineWidth = 0;
        }
        // Break words longer than a whole line.
        let rest = text;
        while (!isSpace && w > width) {
          let n = rest.length;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          const head = rest.slice(0, n);
          lines[lines.length - 1].push({
            font,
            text: head,
            width: font.widthOfTextAtSize(head, size),
          });
          lines.push([]);
          rest = rest.slice(n);
          w = font.widthOfTextAtSize(rest, size);
          lineWidth = 0;
        }
        lines[lines.length - 1].push({ font, text: rest, width: w });
        lineWidth += w;
      }
    }
    return lines.filter((l, i) => l.length > 0 || i < lines.length - 1);
  }

  paragraph(runs: Run[], size: number, indent = 0, after = 6) {
    const lineH = size * 1.3;
    for (const line of this.wrap(runs, size, CONTENT_W - indent)) {
      this.ensure(lineH);
      this.y -= lineH;
      let x = MARGIN + indent;
      for (const piece of line) {
        this.page.drawText(piece.text, {
          x,
          y: this.y + size * 0.25,
          size,
          font: piece.font,
        });
        x += piece.width;
      }
    }
    this.y -= after;
  }

  image(img: PDFImage) {
    const scale = Math.min(1, CONTENT_W / img.width, (PAGE_H - 2 * MARGIN) / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    this.ensure(h);
    this.y -= h;
    this.page.drawImage(img, { x: MARGIN, y: this.y, width: w, height: h });
    this.y -= 6;
  }

  table(rows: Run[][][]) {
    const cols = Math.max(...rows.map((r) => r.length));
    if (cols === 0) return;
    const size = cols > 8 ? 6.5 : 8;
    const colW = CONTENT_W / cols;
    const pad = 2;
    const lineH = size * 1.25;
    for (const row of rows) {
      const wrapped = row.map((cell) => this.wrap(cell, size, colW - 2 * pad));
      const height = Math.max(1, ...wrapped.map((l) => l.length)) * lineH + 2 * pad;
      this.ensure(Math.min(height, PAGE_H - 2 * MARGIN));
      const top = this.y;
      wrapped.forEach((lines, c) => {
        let y = top - pad;
        for (const line of lines) {
          y -= lineH;
          if (y < MARGIN) break; // a single huge cell: clip rather than overflow
          let x = MARGIN + c * colW + pad;
          for (const piece of line) {
            this.page.drawText(piece.text, { x, y: y + size * 0.25, size, font: piece.font });
            x += piece.width;
          }
        }
      });
      const h = Math.min(height, top - MARGIN);
      for (let c = 0; c < cols; c++) {
        this.page.drawRectangle({
          x: MARGIN + c * colW,
          y: top - h,
          width: colW,
          height: h,
          borderColor: rgb(0.5, 0.5, 0.5),
          borderWidth: 0.4,
        });
      }
      this.y = top - h;
    }
    this.y -= 8;
  }
}

function elements(list: ArrayLike<Element> | NodeListOf<Element>): Element[] {
  return Array.prototype.slice.call(list) as Element[];
}

function collectRuns(node: Node, style = { bold: false, italic: false }): Run[] {
  const runs: Run[] = [];
  for (const child of Array.prototype.slice.call(node.childNodes) as Node[]) {
    if (child.nodeType === 3) {
      runs.push({ text: child.textContent ?? "", ...style });
    } else if (child.nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        runs.push({ text: "\n", ...style });
      } else if (tag === "img" || tag === "table") {
        continue;
      } else {
        runs.push(
          ...collectRuns(el, {
            bold: style.bold || tag === "strong" || tag === "b" || /^h\d$/.test(tag),
            italic: style.italic || tag === "em" || tag === "i",
          }),
        );
      }
    }
  }
  return runs;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Decode(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      (B64.indexOf(clean[i + 1]) << 12) |
      ((i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out.subarray(0, o);
}

function dataURIBytes(src: string): { type: string; bytes: Uint8Array } | undefined {
  const m = src.match(/^data:([^;,]+);base64,(.*)$/s);
  if (!m) return undefined;
  return { type: m[1].toLowerCase(), bytes: base64Decode(m[2]) };
}

/**
 * Render simple HTML (as produced by mammoth) into a PDF with pdf-lib:
 * headings, paragraphs, lists, tables and PNG/JPEG images.
 */
export async function renderHTMLToPDF(doc: Document): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const layout = new Layout(pdf, fonts, new TextSanitizer(fonts.regular));
  const headingSize: Record<string, number> = { h1: 16, h2: 14, h3: 12, h4: 11, h5: 10.5, h6: 10.5 };

  const walk = async (node: Element, listDepth = 0) => {
    for (const child of elements(node.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag in headingSize) {
        layout.paragraph(collectRuns(child), headingSize[tag], 0, 4);
      } else if (tag === "p" || tag === "pre" || tag === "blockquote") {
        const runs = collectRuns(child);
        if (runs.some((r) => r.text.trim())) layout.paragraph(runs, 10, listDepth * 14);
        for (const img of elements(child.querySelectorAll("img"))) await drawImage(img);
      } else if (tag === "ul" || tag === "ol") {
        let n = 1;
        for (const li of elements(child.children)) {
          const bullet = tag === "ol" ? `${n++}. ` : "• ";
          const runs = collectRuns(li);
          layout.paragraph(
            [{ text: bullet, bold: false, italic: false }, ...runs],
            10,
            listDepth * 14 + 6,
            2,
          );
          await walk(li, listDepth + 1);
        }
        layout.y -= 4;
      } else if (tag === "table") {
        const rows = elements(child.querySelectorAll("tr")).map((tr) =>
          elements(tr.children).map((td) => collectRuns(td)),
        );
        layout.table(rows);
      } else if (tag === "img") {
        await drawImage(child);
      } else {
        await walk(child, listDepth);
      }
    }
  };

  const drawImage = async (img: Element) => {
    const data = dataURIBytes(img.getAttribute("src") ?? "");
    if (!data) return;
    try {
      if (data.type === "image/png") layout.image(await pdf.embedPng(data.bytes));
      else if (data.type === "image/jpeg" || data.type === "image/jpg") {
        layout.image(await pdf.embedJpg(data.bytes));
      }
    } catch {
      // Unsupported or corrupt image: skip it.
    }
  };

  if (doc.body) await walk(doc.body);
  return pdf.save();
}
