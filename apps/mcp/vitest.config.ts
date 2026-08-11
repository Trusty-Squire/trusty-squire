// Local vitest config so vitest doesn't walk up to the repo-root
// vite.config.ts (which belongs to an unrelated sibling project and
// has a `root:` that breaks when resolved from this package).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    // One test in this suite is memory-heavy enough to OOM a worker at
    // Node's default heap size on a memory-constrained CI runner. Tracked:
    // operator-mandate-web-seam-test-oom.
    pool: "forks",
    poolOptions: {
      forks: {
        execArgv: ["--max-old-space-size=8192"],
      },
    },
  },
});
