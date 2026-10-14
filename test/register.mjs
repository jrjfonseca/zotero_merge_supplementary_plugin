// Lets Node run the TypeScript sources directly in tests: the sources use
// extension-less relative imports (as esbuild allows), so resolve "./x" to
// "./x.ts" when that file exists.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return next(candidate.href, context);
      }
    }
    return next(specifier, context);
  },
});
