import { assert } from "chai";
import { config } from "../package.json";

describe("plugin in Zotero", function () {
  it("loads and exposes its API", function () {
    const plugin = (Zotero as any)[config.addonInstance];
    assert.isOk(plugin?.data.initialized);
    assert.isFunction(plugin.api.fetchAndMergeItem);
  });

  it("can reach the web from Zotero", async function () {
    const xhr = await (Zotero.HTTP as any).request("GET", "https://doi.org/10.1371/journal.pone.0229668", {
      successCodes: false,
      responseType: "text",
    });
    assert.equal(xhr.status, 200, `status ${xhr.status}`);
  });
});
