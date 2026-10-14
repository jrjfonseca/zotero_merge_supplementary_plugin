import { config } from "../../package.json";

// Keys and types are generated from addon/prefs.js into typings/prefs.d.ts.
type PrefsMap = _ZoteroTypes.Prefs["PluginPrefsMap"];

export function getPref<K extends keyof PrefsMap>(key: K): PrefsMap[K] {
  return Zotero.Prefs.get(`${config.prefsPrefix}.${key}`, true) as PrefsMap[K];
}
