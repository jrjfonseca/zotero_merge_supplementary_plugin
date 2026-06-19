import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { performMerge } from "./merge";

const MENU_ID = "mergesupppdf-itemmenu-merge";

// Zotero 9 replaced ad-hoc DOM menu injection with a native, sandboxed
// plugin API: Zotero.MenuManager.registerMenu(). It is registered once,
// globally (not per-window), and Zotero renders it in every window's
// library item context menu.
export function registerMenu() {
  Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-merge-label`,
        // Default arg so the label renders cleanly before onShowing runs.
        l10nArgs: { reason: "" },
        icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
        onShowing: (_event, context) => {
          const state = getMenuState(context.items ?? []);
          context.setEnabled(state.enabled);
          // Append the reason to the label when disabled (e.g. greyed-out
          // "... (need 2 PDFs, found 1)") so the user knows why.
          // setL10nArgs assigns its value straight to dataset.l10nArgs with no
          // serialization, so it MUST be a JSON string — passing an object
          // yields "[object Object]", which Fluent can't parse, leaving the
          // menu label blank (the item then looks like it's missing entirely).
          context.setL10nArgs(JSON.stringify({ reason: state.reason }) as any);
        },
        onCommand: (_event, context) => {
          void onMenuCommand(context.items ?? []);
        },
      },
    ],
  });
}

export function unregisterMenu() {
  Zotero.MenuManager.unregisterMenu(MENU_ID);
}

interface MenuState {
  enabled: boolean;
  reason: string;
}

function getMenuState(items: Zotero.Item[]): MenuState {
  try {
    if (items.length !== 1) {
      return { enabled: false, reason: " (select 1 item)" };
    }

    const item = items[0];
    if (!item.isRegularItem()) {
      return { enabled: false, reason: " (select a regular item)" };
    }

    const attachmentIDs = item.getAttachments();
    let pdfCount = 0;
    for (const id of attachmentIDs) {
      const att = Zotero.Items.get(id);
      if (att.attachmentContentType === "application/pdf") {
        pdfCount++;
      }
    }

    if (pdfCount !== 2) {
      return { enabled: false, reason: ` (need 2 PDFs, found ${pdfCount})` };
    }

    return { enabled: true, reason: "" };
  } catch {
    return { enabled: false, reason: "" };
  }
}

async function onMenuCommand(items: Zotero.Item[]) {
  try {
    if (items.length !== 1) return;
    await performMerge(items[0]);
  } catch (e: any) {
    ztoolkit.log("Merge error:", e);
    new ztoolkit.ProgressWindow(addon.data.config.addonName)
      .createLine({
        text: getString("merge-error-generic", {
          args: { message: e.message || String(e) },
        }),
        type: "error",
      })
      .show();
  }
}
