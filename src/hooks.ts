import { initLocale } from "./utils/locale";
import { registerMenu, unregisterMenu } from "./modules/menu";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);
  initLocale();

  // If the main window is already open, register menu now
  // (onMainWindowLoad won't fire for already-open windows)
  const win = Zotero.getMainWindow();
  if (win) {
    registerMenu(win);
  }

  addon.data.initialized = true;
}

function onMainWindowLoad(win: Window) {
  registerMenu(win);
}

function onMainWindowUnload(win: Window) {
  unregisterMenu(win);
}

function onShutdown() {
  addon.data.alive = false;
  ztoolkit.unregisterAll();
}

export default {
  onStartup,
  onMainWindowLoad,
  onMainWindowUnload,
  onShutdown,
};
