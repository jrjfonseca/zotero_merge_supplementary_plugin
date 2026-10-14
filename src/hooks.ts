import { config } from "../package.json";
import { initLocale } from "./utils/locale";
import { registerMenu, unregisterMenu } from "./modules/menu";
import { registerAutoMerge, unregisterAutoMerge } from "./modules/autoMerge";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();

  // Native Zotero 9 menu API registers globally, once.
  registerMenu();
  registerAutoMerge();

  Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });

  // Make the menu label's Fluent strings resolvable in any already-open window.
  const win = Zotero.getMainWindow();
  if (win) {
    injectFTL(win);
  }

  addon.data.initialized = true;
}

function onMainWindowLoad(win: Window) {
  injectFTL(win);
}

function onMainWindowUnload(_win: Window) {
  // Menu is registered globally; nothing window-specific to tear down.
}

function onShutdown() {
  addon.data.alive = false;
  unregisterMenu();
  unregisterAutoMerge();
  ztoolkit.unregisterAll();
}

// Register the plugin's FTL file with a window so native menu items
// (which reference Fluent l10n IDs) display their labels.
function injectFTL(win: Window) {
  (win as any).MozXULElement?.insertFTLIfNeeded(`${config.addonRef}-addon.ftl`);
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
