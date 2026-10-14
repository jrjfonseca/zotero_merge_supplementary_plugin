// Small wrappers around Zotero/Gecko internals that differ between versions.

let hiddenBrowserClass: any;

/** Zotero's HiddenBrowser (ES module in Zotero 8+, JSM in Zotero 7). */
export async function getHiddenBrowserClass(): Promise<any> {
  if (hiddenBrowserClass) return hiddenBrowserClass;
  try {
    hiddenBrowserClass = ChromeUtils.importESModule(
      "chrome://zotero/content/HiddenBrowser.mjs",
    ).HiddenBrowser;
  } catch {
    hiddenBrowserClass = (ChromeUtils as any).import(
      "chrome://zotero/content/HiddenBrowser.jsm",
    ).HiddenBrowser;
  }
  return hiddenBrowserClass;
}

/** A fresh, uniquely named directory under Zotero's temp directory. */
export async function makeTempDir(prefix: string): Promise<string> {
  const dir = PathUtils.join(
    Zotero.getTempDirectory().path,
    `mergesupppdf-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await IOUtils.makeDirectory(dir, { ignoreExisting: true });
  return dir;
}

/**
 * Copy bytes into an array from this script's global. Gecko APIs hand back
 * typed arrays from another global, which fails pdf-lib's instanceof checks.
 */
export function localBytes(raw: ArrayBuffer | Uint8Array): Uint8Array {
  const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  const arr = new Uint8Array(new ArrayBuffer(src.byteLength));
  arr.set(src);
  return arr;
}
