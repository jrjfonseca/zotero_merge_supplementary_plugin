import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { getUnmergedPDFs, mergeItem } from "./merge";

// Wait this long after the last new PDF on an item before merging, so a
// translator that saves the article and its SI together finishes first.
const SETTLE_DELAY_MS = 4000;
// How long to wait for attachment files that are still downloading.
const FILE_WAIT_MS = 60000;

let observerID: string | undefined;
// parent item ID -> token of the most recent scheduled run
const pending = new Map<number, number>();
let nextToken = 0;
// Parent items whose new attachments are being added by this plugin itself.
const suppressed = new Set<number>();

/** Run `fn` without auto-merge reacting to the attachments it adds. */
export async function suppressAutoMerge<T>(
  parentID: number,
  fn: () => Promise<T>,
): Promise<T> {
  suppressed.add(parentID);
  try {
    return await fn();
  } finally {
    suppressed.delete(parentID);
  }
}

export function registerAutoMerge() {
  observerID = Zotero.Notifier.registerObserver(
    {
      notify: (event, type, ids) => {
        if (event !== "add" || type !== "item") return;
        if (!getPref("autoMerge")) return;
        // Items arriving from sync were (or will be) handled on the device
        // that added them; merging here too would conflict on the file.
        if ((Zotero as any).Sync?.Runner?.syncInProgress) return;
        for (const id of ids as number[]) {
          const item = Zotero.Items.get(id);
          if (
            item &&
            item.isPDFAttachment() &&
            item.parentItemID &&
            !suppressed.has(item.parentItemID)
          ) {
            void schedule(item.parentItemID);
          }
        }
      },
    },
    ["item"],
    `${config.addonRef}-auto-merge`,
  );
}

export function unregisterAutoMerge() {
  if (observerID) Zotero.Notifier.unregisterObserver(observerID);
  observerID = undefined;
  pending.clear();
}

async function schedule(parentID: number) {
  const token = ++nextToken;
  pending.set(parentID, token);
  await Zotero.Promise.delay(SETTLE_DELAY_MS);
  if (pending.get(parentID) !== token) return; // a newer PDF arrived
  pending.delete(parentID);
  if (!addon.data.alive || !getPref("autoMerge")) return;

  const parent = Zotero.Items.get(parentID);
  if (!parent || !parent.isRegularItem() || parent.deleted) return;
  if (getUnmergedPDFs(parent).length < 2) return;

  await waitForFiles(parent);
  const outcome = await mergeItem(parent, { interactive: false });
  ztoolkit.log(`Auto-merge "${parent.getDisplayTitle()}":`, outcome);

  if (outcome.status === "merged") {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("auto-merge-success", {
          args: {
            count: outcome.supplementary.length,
            title: parent.getDisplayTitle(),
          },
        }),
        type: "success",
      })
      .show();
  } else if (outcome.status === "failed") {
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("merge-error-generic", {
          args: { message: outcome.reason },
        }),
        type: "fail",
      })
      .show();
  }
  // "skipped" is the normal case for items without supplementary PDFs.
}

async function waitForFiles(parent: Zotero.Item) {
  const deadline = Date.now() + FILE_WAIT_MS;
  while (Date.now() < deadline && addon.data.alive) {
    let ready = true;
    for (const att of getUnmergedPDFs(parent)) {
      const path = await att.getFilePathAsync();
      if (!path || !(await IOUtils.exists(path))) {
        ready = false;
        break;
      }
    }
    if (ready) return;
    await Zotero.Promise.delay(1000);
  }
}
