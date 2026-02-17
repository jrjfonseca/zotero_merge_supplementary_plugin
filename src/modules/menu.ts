import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { performMerge } from "./merge";

const SEPARATOR_ID = "mergesupppdf-separator";
const MENU_ID = "mergesupppdf-itemmenu-merge";

export function registerMenu(win: Window) {
  // Add a separator before our menu item so it stands out
  ztoolkit.Menu.register("item", {
    tag: "menuseparator",
    id: SEPARATOR_ID,
  });

  // Add the merge menu item with a distinctive label
  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: MENU_ID,
    label: getString("menuitem-merge-label"),
    commandListener: onMenuCommand,
    icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    styles: {
      fontWeight: "bold",
    },
  });

  // Attach popupshowing listener for dynamic label updates
  const itemMenu = win.document.getElementById("zotero-itemmenu");
  if (itemMenu) {
    itemMenu.addEventListener("popupshowing", onPopupShowing);
  }
}

export function unregisterMenu(win: Window) {
  const itemMenu = win.document.getElementById("zotero-itemmenu");
  if (itemMenu) {
    itemMenu.removeEventListener("popupshowing", onPopupShowing);
  }
}

function onPopupShowing(_event: Event) {
  const win = Zotero.getMainWindow();
  if (!win) return;
  const menuItem = win.document.getElementById(MENU_ID);
  const separator = win.document.getElementById(SEPARATOR_ID);
  if (!menuItem) return;

  const state = getMenuState();

  // Always show the menu item, but disable it when conditions aren't met
  (menuItem as any).hidden = false;
  if (separator) (separator as any).hidden = false;

  if (state.enabled) {
    (menuItem as any).disabled = false;
    (menuItem as any).setAttribute(
      "label",
      getString("menuitem-merge-label"),
    );
  } else {
    (menuItem as any).disabled = true;
    (menuItem as any).setAttribute(
      "label",
      getString("menuitem-merge-label") + " " + state.reason,
    );
  }
}

interface MenuState {
  enabled: boolean;
  reason: string;
}

function getMenuState(): MenuState {
  try {
    const zoteroPane = Zotero.getActiveZoteroPane();
    const selectedItems = zoteroPane.getSelectedItems();

    if (selectedItems.length !== 1) {
      return { enabled: false, reason: "(select 1 item)" };
    }

    const item = selectedItems[0];
    if (!item.isRegularItem()) {
      return { enabled: false, reason: "(select a regular item)" };
    }

    const attachmentIDs = item.getAttachments();
    let pdfCount = 0;
    for (const id of attachmentIDs) {
      const att = Zotero.Items.get(id);
      if (att.attachmentContentType === "application/pdf") {
        pdfCount++;
      }
    }

    if (pdfCount < 2) {
      return { enabled: false, reason: `(need 2 PDFs, found ${pdfCount})` };
    }
    if (pdfCount > 2) {
      return { enabled: false, reason: `(need 2 PDFs, found ${pdfCount})` };
    }

    return { enabled: true, reason: "" };
  } catch {
    return { enabled: false, reason: "" };
  }
}

async function onMenuCommand(_event: Event) {
  try {
    const zoteroPane = Zotero.getActiveZoteroPane();
    const selectedItems = zoteroPane.getSelectedItems();
    if (selectedItems.length !== 1) return;

    await performMerge(selectedItems[0]);
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
