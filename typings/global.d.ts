declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

declare const IOUtils: {
  read(path: string): Promise<Uint8Array>;
  write(
    path: string,
    data: Uint8Array,
    options?: { tmpPath?: string },
  ): Promise<number>;
  exists(path: string): Promise<boolean>;
  copy(
    sourcePath: string,
    destPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean }): Promise<void>;
  move(
    sourcePath: string,
    destPath: string,
    options?: { noOverwrite?: boolean },
  ): Promise<void>;
};

declare const PathUtils: {
  join(...parts: string[]): string;
  filename(path: string): string;
  parent(path: string): string | null;
};
