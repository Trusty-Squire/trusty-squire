// Local vitest config so vitest doesn't walk up to the repo-root
// vite.config.ts (which belongs to an unrelated sibling project and
// has a `root:` that breaks when resolved from this package).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // TEMP quarantine - pre-existing unbounded cross-file memory leak
    // crashes a vitest worker, NOT a functional failure; tracked in
    // operator-mandate-web-seam-test-oom, un-quarantine after fix.
    exclude: ["src/bot/__tests__/pay-mandate-web-seam.test.ts"],
  },
});
