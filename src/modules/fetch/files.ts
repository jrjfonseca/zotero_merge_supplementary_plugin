// Recognising downloaded files and unpacking archives. Pure code (no Zotero
// APIs), so it can be tested in Node.

import { Unzip, UnzipInflate } from "fflate";

export type FileType =
  | "pdf"
  | "docx"
  | "doc"
  | "odt"
  | "rtf"
  | "zip"
  | "html"
  | "unknown";

export type ConvertibleType = Extract<FileType, "docx" | "doc" | "odt" | "rtf">;

export function isConvertible(type: FileType): type is ConvertibleType {
  return type === "docx" || type === "doc" || type === "odt" || type === "rtf";
}

export interface NamedFile {
  name: string;
  bytes: Uint8Array;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((b, i) => bytes[offset + i] === b);
}

function includesAscii(bytes: Uint8Array, needle: string, limit?: number) {
  const n = Array.from(needle, (c) => c.charCodeAt(0));
  const end = Math.min(bytes.length, limit ?? bytes.length) - n.length;
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < n.length; j++) {
      if (bytes[i + j] !== n[j]) continue outer;
    }
    return true;
  }
  return false;
}

/** Identify a file from its content (extensions and headers lie). */
export function sniff(bytes: Uint8Array): FileType {
  if (includesAscii(bytes, "%PDF-", 1024)) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (includesAscii(bytes, "word/document.xml")) return "docx";
    if (includesAscii(bytes, "application/vnd.oasis.opendocument.text", 200)) {
      return "odt";
    }
    return "zip";
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "doc";
  }
  if (includesAscii(bytes, "{\\rtf", 16)) return "rtf";
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 2048))
    .trimStart()
    .toLowerCase();
  if (/^(<!doctype html|<html|<head|<body|<\?xml[^>]*>\s*<html|<!--)/.test(head)) {
    return "html";
  }
  if (/<html[\s>]/.test(head)) return "html";
  return "unknown";
}

const WANTED_IN_ZIP = /\.(pdf|docx?|odt|rtf)$/i;

/**
 * Extract the document files (PDF/DOCX/DOC/ODT/RTF) from a ZIP archive.
 *
 * Streams through local file headers instead of relying on the central
 * directory, so archives that are streamed without one (Europe PMC) or cut
 * off part-way still yield every complete file.
 */
export function extractDocumentsFromZip(bytes: Uint8Array): NamedFile[] {
  const out: NamedFile[] = [];
  const unzip = new Unzip((file) => {
    const base = file.name.split("/").pop() ?? file.name;
    if (
      !WANTED_IN_ZIP.test(base) ||
      file.name.startsWith("__MACOSX/") ||
      base.startsWith(".")
    ) {
      return;
    }
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) return;
      chunks.push(data);
      if (final) out.push({ name: base, bytes: concat(chunks) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    unzip.push(bytes, true);
  } catch {
    // Truncated or trailing garbage: keep whatever was complete.
  }
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Make a name safe for a file system, keeping its extension. */
export function safeFileName(name: string, fallbackExt = "pdf"): string {
  let clean = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-120);
  if (!clean || /^\.+$/.test(clean)) clean = "supplementary";
  if (!/\.[a-z0-9]{2,5}$/i.test(clean)) clean += `.${fallbackExt}`;
  return clean;
}
