import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { classify, scoreCandidate, type ScoredCandidate } from "./detect";
import { appendSupplements, EncryptedPDFError } from "./pdf";
import { pickManually } from "./picker";

/**
 * Automatic tag put on supplementary attachments once they have been merged,
 * so they are never merged twice and can be found again for "Restore".
 */
export const MERGED_TAG = "_merged-supplementary";

export type MergeOutcome =
  | {
      status: "merged";
      main: Zotero.Item;
      supplementary: Zotero.Item[];
      addedPages: number;
    }
  | { status: "skipped"; reason: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: string };

export interface MergeOptions {
  /** Ask the user (picker dialog) when detection isn't confident */
  interactive: boolean;
  /** Attachment IDs known to be supplementary (e.g. just downloaded as SI) */
  knownSupplementary?: Set<number>;
}

type Candidate = ScoredCandidate<Zotero.Item> & { path: string };

// Items currently being merged, so manual and automatic merges never race.
const busy = new Set<number>();

/** Regular items for a selection that may include attachments. */
export function resolveParents(items: Zotero.Item[]): Zotero.Item[] {
  const seen = new Map<number, Zotero.Item>();
  for (const item of items) {
    let parent: Zotero.Item | false = item;
    if (item.isAttachment() && item.parentItemID) {
      parent = Zotero.Items.get(item.parentItemID);
    }
    if (parent && parent.isRegularItem() && !seen.has(parent.id)) {
      seen.set(parent.id, parent);
    }
  }
  return [...seen.values()];
}

export function getPDFAttachments(
  parent: Zotero.Item,
  includeTrashed = false,
): Zotero.Item[] {
  return parent
    .getAttachments(includeTrashed)
    .map((id) => Zotero.Items.get(id))
    .filter((att) => att && att.isPDFAttachment());
}

/** PDFs that are still candidates for merging (not merged already). */
export function getUnmergedPDFs(parent: Zotero.Item): Zotero.Item[] {
  return getPDFAttachments(parent).filter((att) => !att.hasTag(MERGED_TAG));
}

export function hasMergedAttachments(parent: Zotero.Item): boolean {
  return getPDFAttachments(parent, true).some((att) => att.hasTag(MERGED_TAG));
}

export function backupPathFor(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot > 0
    ? `${filePath.substring(0, dot)}.backup${filePath.substring(dot)}`
    : `${filePath}.backup`;
}

function safeField(item: Zotero.Item, field: string): string {
  try {
    return String(item.getField(field as any) ?? "");
  } catch {
    return "";
  }
}

export function parentDOI(parent: Zotero.Item): string | undefined {
  const doi = safeField(parent, "DOI");
  if (doi) return doi.trim();
  // Item types without a DOI field often keep it in Extra.
  const extra = safeField(parent, "extra").match(/^DOI:\s*(\S+)/im);
  return extra?.[1];
}

async function firstPagesText(att: Zotero.Item): Promise<string | undefined> {
  try {
    const result = await (Zotero as any).PDFWorker.getFullText(att.id, 2, true);
    const text = result?.text;
    return typeof text === "string" && text.trim() ? text : undefined;
  } catch (e) {
    ztoolkit.log(`Could not read text of "${att.getDisplayTitle()}"`, e);
    return undefined;
  }
}

async function scoreAttachments(
  parent: Zotero.Item,
  known: Set<number> = new Set(),
): Promise<Candidate[]> {
  const useText = getPref("useContentDetection");
  const parentTitle = safeField(parent, "title");
  const doi = parentDOI(parent);
  const candidates: Candidate[] = [];

  for (const att of getUnmergedPDFs(parent)) {
    const path = await att.getFilePathAsync();
    if (!path || !(await IOUtils.exists(path))) continue;
    const scored = scoreCandidate(att, {
      title: att.getDisplayTitle(),
      filename: att.attachmentFilename || "",
      text: useText ? await firstPagesText(att) : undefined,
      parentTitle,
      parentDOI: doi,
    });
    if (known.has(att.id)) {
      scored.score += 10;
      scored.reasons.push("downloaded from the article's supplementary files");
    }
    candidates.push({ ...scored, path });
  }
  return candidates;
}

async function readBytes(path: string): Promise<Uint8Array> {
  // Gecko's IOUtils returns a typed array from a different global, so
  // pdf-lib's instanceof checks fail. Copy into an array from this scope.
  const raw = await IOUtils.read(path);
  const arr = new Uint8Array(new ArrayBuffer(raw.byteLength));
  arr.set(raw);
  return arr;
}

/**
 * Detect the main and supplementary PDFs of `parent` and merge them.
 * Never throws: every problem is reported through the returned outcome.
 */
export async function mergeItem(
  parent: Zotero.Item,
  options: MergeOptions,
): Promise<MergeOutcome> {
  if (busy.has(parent.id)) {
    return { status: "skipped", reason: getString("reason-busy") };
  }
  busy.add(parent.id);
  try {
    return await mergeItemUnlocked(parent, options);
  } catch (e: any) {
    ztoolkit.log("Merge failed:", e);
    if (e instanceof EncryptedPDFError) {
      return { status: "failed", reason: getString("merge-error-encrypted") };
    }
    return { status: "failed", reason: e?.message || String(e) };
  } finally {
    busy.delete(parent.id);
  }
}

async function mergeItemUnlocked(
  parent: Zotero.Item,
  options: MergeOptions,
): Promise<MergeOutcome> {
  if (!parent.library.editable || !parent.library.filesEditable) {
    return { status: "skipped", reason: getString("reason-read-only") };
  }

  const candidates = await scoreAttachments(parent, options.knownSupplementary);
  if (candidates.length < 2) {
    return {
      status: "skipped",
      reason: getString("reason-not-enough-pdfs", {
        args: { count: candidates.length },
      }),
    };
  }

  // Merged with an older version of this plugin, which didn't tag anything:
  // the main PDF already has a backup but nothing is marked as merged.
  if (!hasMergedAttachments(parent)) {
    for (const c of candidates) {
      if (await IOUtils.exists(backupPathFor(c.path))) {
        return { status: "skipped", reason: getString("reason-legacy-merge") };
      }
    }
  }

  const result = classify(candidates, {
    sortName: (c) => `${c.ref.getDisplayTitle()} ${c.ref.attachmentFilename}`,
    dateAdded: (c) => Date.parse(c.ref.dateAdded) || 0,
  });
  for (const c of candidates) {
    ztoolkit.log(
      `"${c.ref.getDisplayTitle()}" score=${c.score}: ${c.reasons.join("; ")}`,
    );
  }

  let main: Candidate;
  let supplementary: Candidate[];
  if (result.confident) {
    main = result.main as Candidate;
    supplementary = result.supplementary as Candidate[];
  } else if (options.interactive) {
    const picked = await pickManually(parent, candidates, result);
    if (!picked) return { status: "cancelled" };
    main = picked.main as Candidate;
    supplementary = picked.supplementary as Candidate[];
  } else {
    return { status: "skipped", reason: result.reason };
  }

  if (supplementary.length === 0) return { status: "cancelled" };

  const mainBytes = await readBytes(main.path);
  const supplements = [];
  for (const s of supplementary) {
    supplements.push({
      bytes: await readBytes(s.path),
      label: s.ref.getDisplayTitle() || getString("outline-supplementary"),
    });
  }

  const merged = await appendSupplements(mainBytes, supplements, {
    addOutline: getPref("addOutline"),
    mainLabel: getString("outline-main"),
  });
  if (merged.totalPages <= merged.mainPages) {
    return { status: "failed", reason: getString("reason-no-pages-added") };
  }

  // Keep the very first original: a later merge (e.g. a second SI file
  // attached afterwards) must not overwrite it with an already-merged PDF.
  const backupPath = backupPathFor(main.path);
  if (getPref("keepBackup") && !(await IOUtils.exists(backupPath))) {
    await IOUtils.copy(main.path, backupPath);
  }

  await IOUtils.write(main.path, merged.bytes, {
    tmpPath: `${main.path}.mergesupp.tmp`,
  });

  const trash = getPref("trashSupplementary");
  await Zotero.DB.executeTransaction(async () => {
    for (const s of supplementary) {
      s.ref.addTag(MERGED_TAG, 1);
      if (trash) s.ref.deleted = true;
      await s.ref.save();
    }
  });

  // Refresh full-text search for the new pages; not worth failing over.
  Zotero.Fulltext.indexItems([main.ref.id], {
    complete: true,
    ignoreErrors: true,
  }).catch((e: unknown) => ztoolkit.log("Reindex failed", e));

  return {
    status: "merged",
    main: main.ref,
    supplementary: supplementary.map((s) => s.ref),
    addedPages: merged.totalPages - merged.mainPages,
  };
}

/**
 * Undo a merge: put the backed-up original back in place of the main PDF
 * and un-mark (and un-trash) the supplementary attachments.
 */
export async function restoreItem(parent: Zotero.Item): Promise<MergeOutcome> {
  if (busy.has(parent.id)) {
    return { status: "skipped", reason: getString("reason-busy") };
  }
  busy.add(parent.id);
  try {
    let restored: Zotero.Item | undefined;
    for (const att of getUnmergedPDFs(parent)) {
      const path = await att.getFilePathAsync();
      if (!path) continue;
      const backup = backupPathFor(path);
      if (await IOUtils.exists(backup)) {
        await IOUtils.move(backup, path);
        restored = att;
        Zotero.Fulltext.indexItems([att.id], {
          complete: true,
          ignoreErrors: true,
        }).catch((e: unknown) => ztoolkit.log("Reindex failed", e));
      }
    }

    // Without a backup the main PDF still contains the supplementary pages,
    // so keep the tags; otherwise the next merge would append them again.
    if (!restored) {
      return { status: "skipped", reason: getString("reason-no-backup") };
    }

    const marked = getPDFAttachments(parent, true).filter((att) =>
      att.hasTag(MERGED_TAG),
    );
    await Zotero.DB.executeTransaction(async () => {
      for (const att of marked) {
        att.removeTag(MERGED_TAG);
        att.deleted = false;
        await att.save();
      }
    });

    return {
      status: "merged",
      main: restored,
      supplementary: marked,
      addedPages: 0,
    };
  } catch (e: any) {
    ztoolkit.log("Restore failed:", e);
    return { status: "failed", reason: e?.message || String(e) };
  } finally {
    busy.delete(parent.id);
  }
}

/** True if the selection has anything the merge command could work on. */
export function isMergeable(parent: Zotero.Item): boolean {
  return getUnmergedPDFs(parent).length >= 2;
}

/**
 * Merge one or many items, with a progress window and a final summary.
 * Only a single item is merged interactively; batches merge confident
 * matches and report the rest as skipped.
 */
export async function mergeItems(parents: Zotero.Item[]): Promise<void> {
  const interactive = parents.length === 1;
  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({
      text: getString("merge-progress"),
      type: "default",
      progress: 0,
    })
    .show();

  let merged = 0;
  let skipped = 0;
  let failed = 0;
  let last: MergeOutcome | undefined;

  for (const [i, parent] of parents.entries()) {
    if (!interactive) {
      progress.changeLine({
        text: getString("merge-progress-batch", {
          args: { current: i + 1, total: parents.length },
        }),
        progress: Math.round((i / parents.length) * 100),
      });
    }
    last = await mergeItem(parent, { interactive });
    if (last.status === "merged") merged++;
    else if (last.status === "failed") {
      failed++;
      ztoolkit.log(`"${parent.getDisplayTitle()}": ${last.reason}`);
    } else if (last.status === "skipped") {
      skipped++;
      ztoolkit.log(`Skipped "${parent.getDisplayTitle()}": ${last.reason}`);
    }
  }

  if (interactive && last) {
    reportSingle(progress, last);
  } else {
    progress.changeLine({
      text: getString("merge-summary", { args: { merged, skipped, failed } }),
      type: failed > 0 ? "fail" : "success",
      progress: 100,
    });
    if (skipped > 0) {
      progress.createLine({ text: getString("merge-summary-hint") });
    }
  }
  progress.startCloseTimer(interactive ? 5000 : 10000);
}

function reportSingle(
  progress: InstanceType<typeof ztoolkit.ProgressWindow>,
  outcome: MergeOutcome,
) {
  switch (outcome.status) {
    case "merged":
      progress.changeLine({
        text: getString("merge-success", {
          args: {
            count: outcome.supplementary.length,
            pages: outcome.addedPages,
            mainTitle: outcome.main.getDisplayTitle(),
          },
        }),
        type: "success",
        progress: 100,
      });
      break;
    case "cancelled":
      progress.changeLine({
        text: getString("merge-cancelled"),
        type: "default",
        progress: 100,
      });
      break;
    case "skipped":
    case "failed":
      progress.changeLine({
        text: getString("merge-error-generic", {
          args: { message: outcome.reason },
        }),
        type: "fail",
        progress: 100,
      });
      break;
  }
}

export async function restoreItems(parents: Zotero.Item[]): Promise<void> {
  const progress = new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("restore-progress"), progress: 0 })
    .show();
  let restored = 0;
  let lastError = "";
  for (const parent of parents) {
    const outcome = await restoreItem(parent);
    if (outcome.status === "merged") restored++;
    else if (outcome.status === "failed" || outcome.status === "skipped") {
      lastError = outcome.reason;
    }
  }
  progress.changeLine({
    text:
      restored > 0
        ? getString("restore-success", { args: { count: restored } })
        : getString("merge-error-generic", { args: { message: lastError } }),
    type: restored > 0 ? "success" : "fail",
    progress: 100,
  });
  progress.startCloseTimer(5000);
}
