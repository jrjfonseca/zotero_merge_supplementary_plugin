import { BasicTool } from "zotero-plugin-toolkit";
import Addon from "./addon";
import { config } from "../package.json";

const basicTool = new BasicTool();

// @ts-expect-error - Plugin instance is not typed
if (!basicTool.getGlobal("Zotero")[config.addonInstance]) {
  _globalThis.addon = new Addon();
  defineGlobal("ztoolkit", () => {
    return _globalThis.addon.data.ztoolkit;
  });
  // mammoth's bundled JSZip calls setImmediate, which Zotero's plugin
  // sandbox lacks (it has setTimeout).
  const g = globalThis as any;
  if (typeof g.setImmediate === "undefined") {
    _globalThis.setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
      g.setTimeout(fn, 0, ...args);
    _globalThis.clearImmediate = (id: number) => g.clearTimeout(id);
  }
  // @ts-expect-error - Plugin instance is not typed
  Zotero[config.addonInstance] = addon;
}

function defineGlobal(name: Parameters<BasicTool["getGlobal"]>[0]): void;
function defineGlobal(name: string, getter: () => any): void;
function defineGlobal(name: string, getter?: () => any) {
  Object.defineProperty(_globalThis, name, {
    get() {
      return getter ? getter() : basicTool.getGlobal(name);
    },
  });
}
