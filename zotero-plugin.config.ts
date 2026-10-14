import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

// Optional, for running the in-Zotero tests behind an HTTPS proxy:
//   ZOTERO_TEST_PROXY=host:port   route Zotero's HTTPS traffic through it
//   ZOTERO_TEST_CA=/path/ca.crt   trust this CA in the test profile (needs certutil)
const [proxyHost, proxyPort] = (process.env.ZOTERO_TEST_PROXY ?? "").split(":");
const proxyPrefs: Record<string, string | number | boolean> = proxyHost
  ? {
      "network.proxy.type": 1,
      "network.proxy.ssl": proxyHost,
      "network.proxy.ssl_port": Number(proxyPort),
      "network.proxy.http": proxyHost,
      "network.proxy.http_port": Number(proxyPort),
    }
  : {};

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage || "",
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    // Node unit tests live in test/; these run inside a real Zotero.
    entries: ["test-zotero"],
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
    watch: false,
    mocha: { timeout: 900000 },
    prefs: proxyPrefs,
    hooks: {
      "test:init": () => {
        const ca = process.env.ZOTERO_TEST_CA;
        if (!ca) return;
        const db = "sql:.scaffold/test/profile";
        execFileSync("certutil", ["-N", "-d", db, "--empty-password"]);
        // certutil imports one certificate per call; a CA file may hold a chain.
        const pems = readFileSync(ca, "utf8").match(
          /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
        );
        pems?.forEach((pem, i) =>
          execFileSync(
            "certutil",
            ["-A", "-n", `test-proxy-ca-${i}`, "-t", "C,,", "-d", db],
            { input: pem },
          ),
        );
      },
    },
  },
});
