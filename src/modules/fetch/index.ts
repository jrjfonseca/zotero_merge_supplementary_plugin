// One click: find an item's supplementary files on the web, download them,
// convert Word/ODT/RTF to PDF, attach them, and merge them into the main PDF.

import { getString } from "../../utils/locale";
import { localBytes, makeTempDir } from "../../utils/gecko";
import { suppressAutoMerge } from "../autoMerge";
import { convertToPDF } from "../convert";
import {
  getPDFAttachments,
  getUnmergedPDFs,
  mergeItem,
  parentDOI,
  type MergeOutcome,
} from "../merge";
import { countPages, EncryptedPDFError } from "../pdf";
import { Discovery, startURLs } from "./discover";
import { isConvertible, safeFileName, sameBytes } from "./files";
import { zoteroNet } from "./web";

export type FetchOutcome =
  | { status: "done"; added: number; merge?: MergeOutcome; notes: string[] }
  | { status: "none"; reason: string; merge?: MergeOutcome }
  | { status: "failed"; reason: string };

type Report = (text: string) => void;

function safeField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) ?? "");
  } catch {
    return "";
  }
}

export function canFetch(item: Zotero.Item): boolean {
  return Boolean(parentDOI(item) || /^https?:\/\//i.test(safeField(item, "url")));
}

// ---------------------------------------------------------------------------
// Attach + merge

/** Name without extension, so "Table_3.docx" matches its converted "Table_3.pdf". */
function baseName(name: string): string {
  return name.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, "");
}

async function readAttachment(att: Zotero.Item): Promise<Uint8Array | null> {
  const path = await att.getFilePathAsync();
  if (!path || !(await IOUtils.exists(path))) return null;
  return localBytes(await IOUtils.read(path));
}

export async function fetchAndMergeItem(
  parent: Zotero.Item,
  options: { interactive: boolean; report?: Report },
): Promise<FetchOutcome> {
  const report = options.report ?? (() => {});
  if (!parent.library.editable || !parent.library.filesEditable) {
    return { status: "failed", reason: getString("reason-read-only") };
  }
  if (!canFetch(parent)) {
    return { status: "failed", reason: getString("fetch-error-no-identifier") };
  }

  // Make sure there is a main PDF to merge into.
  if (getPDFAttachments(parent, true).length === 0) {
    report(getString("fetch-progress-main"));
    try {
      await Zotero.Attachments.addAvailableFile(parent);
    } catch (e) {
      ztoolkit.log("Find Available PDF failed", e);
    }
  }

  const found = await new Discovery(
    zoteroNet,
    (key, args) => report(getString(key as any, { args })),
    parentDOI(parent),
  ).run(startURLs(parentDOI(parent), safeField(parent, "url")));
  const notes: string[] = [];

  // Skip files that are already attached (by name or identical content),
  // including the main article PDF that some sites list with the SI.
  const existing = getPDFAttachments(parent, true);
  const existingNames = new Set(
    existing.flatMap((a) => [
      baseName(a.getDisplayTitle()),
      baseName(a.attachmentFilename || ""),
    ]),
  );
  const existingBytes: Uint8Array[] = [];
  for (const att of existing) {
    const bytes = await readAttachment(att);
    if (bytes) existingBytes.push(bytes);
  }

  const toAttach: { name: string; bytes: Uint8Array }[] = [];
  for (const f of found) {
    if (existingNames.has(baseName(f.name))) continue;
    if (existingBytes.some((b) => sameBytes(b, f.bytes))) continue;

    let pdfBytes = f.bytes;
    let name = f.name;
    if (isConvertible(f.type)) {
      report(getString("fetch-progress-convert", { args: { name: f.name } }));
      try {
        const converted = await convertToPDF(f.bytes, f.type, f.name);
        pdfBytes = converted.bytes;
        name = `${f.name.replace(/\.[a-z0-9]{2,5}$/i, "")}.pdf`;
        ztoolkit.log(`Converted ${f.name} with ${converted.method}`);
      } catch (e: any) {
        notes.push(
          getString("fetch-note-convert-failed", {
            args: { name: f.name, reason: e?.message ?? String(e) },
          }),
        );
        continue;
      }
    }
    try {
      await countPages(pdfBytes);
    } catch (e) {
      notes.push(
        getString(
          e instanceof EncryptedPDFError
            ? "fetch-note-encrypted"
            : "fetch-note-invalid",
          { args: { name: f.name } },
        ),
      );
      continue;
    }
    toAttach.push({ name: safeFileName(name), bytes: pdfBytes });
  }

  const added: number[] = [];
  if (toAttach.length) {
    report(getString("fetch-progress-attach", { args: { count: toAttach.length } }));
    const dir = await makeTempDir("fetch");
    try {
      for (const [i, f] of toAttach.entries()) {
        const sub = PathUtils.join(dir, String(i));
        await IOUtils.makeDirectory(sub, { ignoreExisting: true });
        const path = PathUtils.join(sub, f.name);
        await IOUtils.write(path, f.bytes);
        const att = await Zotero.Attachments.importFromFile({
          file: path,
          parentItemID: parent.id,
          title: f.name,
        });
        added.push(att.id);
      }
    } finally {
      await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
    }
  }

  // Merge whatever is there now: the new files, plus any SI PDFs that were
  // already attached but not merged.
  let merge: MergeOutcome | undefined;
  if (getUnmergedPDFs(parent).length >= 2) {
    report(getString("merge-progress"));
    merge = await mergeItem(parent, {
      interactive: options.interactive,
      knownSupplementary: new Set(added),
    });
  }

  if (added.length === 0) {
    return {
      status: "none",
      reason:
        notes[0] ??
        (found.length
          ? getString("fetch-none-new")
          : getString("fetch-none-found")),
      merge,
    };
  }
  return { status: "done", added: added.length, merge, notes };
}

export async function fetchAndMergeItems(parents: Zotero.Item[]): Promise<void> {
  const interactive = parents.length === 1;
  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("fetch-progress-start"), progress: 0 })
    .show();

  let merged = 0;
  let nothing = 0;
  let failed = 0;
  const messages: string[] = [];

  for (const [i, parent] of parents.entries()) {
    const prefix = interactive ? "" : `(${i + 1}/${parents.length}) `;
    const report: Report = (text) =>
      progress.changeLine({
        text: prefix + text,
        progress: Math.round((i / parents.length) * 100),
      });
    let outcome: FetchOutcome;
    try {
      // Auto-merge must not react to the PDFs this adds; it merges itself.
      outcome = await suppressAutoMerge(parent.id, () =>
        fetchAndMergeItem(parent, { interactive, report }),
      );
    } catch (e: any) {
      ztoolkit.log("Fetch failed", e);
      outcome = { status: "failed", reason: e?.message ?? String(e) };
    }
    ztoolkit.log(`Fetch "${parent.getDisplayTitle()}":`, outcome);

    if (outcome.status === "failed") {
      failed++;
      messages.push(outcome.reason);
    } else if (outcome.merge?.status === "merged") {
      merged++;
      if (outcome.status === "done") messages.push(...outcome.notes);
    } else {
      nothing++;
      if (outcome.status === "none") messages.push(outcome.reason);
      else {
        messages.push(...outcome.notes);
        messages.push(mergeProblem(outcome.merge));
      }
    }
  }

  if (interactive) {
    const ok = merged === 1;
    progress.changeLine({
      text: ok
        ? getString("fetch-success")
        : messages[0] || getString("fetch-none-found"),
      type: ok ? "success" : failed ? "fail" : "default",
      progress: 100,
    });
    for (const m of messages.slice(ok ? 0 : 1, 4)) progress.createLine({ text: m });
  } else {
    progress.changeLine({
      text: getString("fetch-summary", { args: { merged, nothing, failed } }),
      type: failed ? "fail" : "success",
      progress: 100,
    });
  }
  progress.startCloseTimer(interactive ? 8000 : 12000);
}

function mergeProblem(merge?: MergeOutcome): string {
  if (!merge) return getString("fetch-no-main");
  if (merge.status === "skipped" || merge.status === "failed") {
    return getString("merge-error-generic", { args: { message: merge.reason } });
  }
  if (merge.status === "cancelled") return getString("merge-cancelled");
  return "";
}
