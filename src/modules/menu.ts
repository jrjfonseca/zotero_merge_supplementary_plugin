import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { canFetch, fetchAndMergeItems } from "./fetch";
import {
  getUnmergedPDFs,
  hasMergedAttachments,
  isMergeable,
  mergeItems,
  resolveParents,
  restoreItems,
} from "./merge";

const ITEM_MENU_ID = "mergesupppdf-itemmenu";
const COLLECTION_MENU_ID = "mergesupppdf-collectionmenu";
const ICON = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;

// Zotero 9 replaced ad-hoc DOM menu injection with a native, sandboxed
// plugin API: Zotero.MenuManager.registerMenu(). It is registered once,
// globally (not per-window), and Zotero renders it in every window.
export function registerMenu() {
  Zotero.MenuManager.registerMenu({
    menuID: ITEM_MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-fetch-label`,
        l10nArgs: { reason: "" },
        icon: ICON,
        onShowing: (_event, context) => {
          const parents = resolveParents(context.items ?? []);
          const fetchable = parents.filter(canFetch).length;
          let reason = "";
          if (parents.length === 0) reason = " (select an item)";
          else if (fetchable === 0) reason = " (item has no DOI or URL)";
          else if (parents.length > 1) reason = ` (${fetchable} items)`;
          context.setEnabled(fetchable > 0);
          context.setL10nArgs(JSON.stringify({ reason }) as any);
        },
        onCommand: (_event, context) => {
          const parents = resolveParents(context.items ?? []).filter(canFetch);
          if (parents.length > 0) void fetchAndMergeItems(parents);
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-merge-label`,
        // Default arg so the label renders cleanly before onShowing runs.
        l10nArgs: { reason: "" },
        icon: ICON,
        onShowing: (_event, context) => {
          const state = getMergeMenuState(context.items ?? []);
          context.setEnabled(state.enabled);
          // setL10nArgs assigns its value straight to dataset.l10nArgs with no
          // serialization, so it MUST be a JSON string — passing an object
          // yields "[object Object]", which Fluent can't parse, leaving the
          // menu label blank (the item then looks like it's missing entirely).
          context.setL10nArgs(JSON.stringify({ reason: state.reason }) as any);
        },
        onCommand: (_event, context) => {
          const parents = resolveParents(context.items ?? []).filter(
            isMergeable,
          );
          if (parents.length > 0) void mergeItems(parents);
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-restore-label`,
        icon: ICON,
        onShowing: (_event, context) => {
          const parents = resolveParents(context.items ?? []);
          context.setVisible(parents.some(hasMergedAttachments));
        },
        onCommand: (_event, context) => {
          const parents = resolveParents(context.items ?? []).filter(
            hasMergedAttachments,
          );
          if (parents.length > 0) void restoreItems(parents);
        },
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: COLLECTION_MENU_ID,
    pluginID: config.addonID,
    target: "main/library/collection",
    menus: [
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-fetch-collection-label`,
        icon: ICON,
        onShowing: (_event, context) => {
          const row = context.collectionTreeRow as any;
          context.setVisible(Boolean(row?.isCollection?.()));
        },
        onCommand: (_event, context) => {
          const row = context.collectionTreeRow as any;
          if (row?.isCollection?.()) void fetchCollection(row.ref);
        },
      },
      {
        menuType: "menuitem",
        l10nID: `${config.addonRef}-menuitem-merge-collection-label`,
        icon: ICON,
        onShowing: (_event, context) => {
          const row = context.collectionTreeRow as any;
          context.setVisible(Boolean(row?.isCollection?.()));
        },
        onCommand: (_event, context) => {
          const row = context.collectionTreeRow as any;
          if (row?.isCollection?.()) void mergeCollection(row.ref);
        },
      },
    ],
  });
}

export function unregisterMenu() {
  Zotero.MenuManager.unregisterMenu(ITEM_MENU_ID);
  Zotero.MenuManager.unregisterMenu(COLLECTION_MENU_ID);
}

interface MenuState {
  enabled: boolean;
  reason: string;
}

function getMergeMenuState(items: Zotero.Item[]): MenuState {
  try {
    const parents = resolveParents(items);
    if (parents.length === 0) {
      return { enabled: false, reason: " (select an item)" };
    }
    if (parents.length === 1) {
      const count = getUnmergedPDFs(parents[0]).length;
      return count >= 2
        ? { enabled: true, reason: "" }
        : { enabled: false, reason: ` (need 2+ PDFs, found ${count})` };
    }
    const mergeable = parents.filter(isMergeable).length;
    return mergeable > 0
      ? { enabled: true, reason: ` (${mergeable} items)` }
      : { enabled: false, reason: " (no item has 2+ PDFs)" };
  } catch {
    return { enabled: false, reason: "" };
  }
}

async function mergeCollection(collection: Zotero.Collection) {
  const parents = resolveParents(collection.getChildItems(false)).filter(
    isMergeable,
  );
  const win = Zotero.getMainWindow();
  if (parents.length === 0) {
    Services.prompt.alert(
      win as any,
      addon.data.config.addonName,
      getString("collection-nothing-to-merge"),
    );
    return;
  }
  const ok = Services.prompt.confirm(
    win as any,
    addon.data.config.addonName,
    getString("collection-confirm", {
      args: { count: parents.length, name: collection.name },
    }),
  );
  if (ok) await mergeItems(parents);
}

async function fetchCollection(collection: Zotero.Collection) {
  const parents = resolveParents(collection.getChildItems(false)).filter(
    canFetch,
  );
  const win = Zotero.getMainWindow();
  if (parents.length === 0) {
    Services.prompt.alert(
      win as any,
      addon.data.config.addonName,
      getString("collection-nothing-to-fetch"),
    );
    return;
  }
  const ok = Services.prompt.confirm(
    win as any,
    addon.data.config.addonName,
    getString("collection-fetch-confirm", {
      args: { count: parents.length, name: collection.name },
    }),
  );
  if (ok) await fetchAndMergeItems(parents);
}
