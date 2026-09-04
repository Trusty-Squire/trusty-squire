// Local vitest config so vitest doesn't walk up to the repo-root
// vite.config.ts (which belongs to an unrelated sibling project and
// has a `root:` that breaks when resolved from this package).
import { defineConfig } from "vitest/config";
import { MCP_TEST_INCLUDE_GLOBS, QUARANTINED_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: MCP_TEST_INCLUDE_GLOBS,
    // TEMP quarantine - pre-existing unbounded cross-file memory leak
    // crashes a vitest worker, NOT a functional failure; tracked in
    // operator-mandate-web-seam-test-oom, un-quarantine after fix.
    exclude: QUARANTINED_FILES,
  },
});
