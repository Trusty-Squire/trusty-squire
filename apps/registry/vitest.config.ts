// Local vitest config so vitest doesn't walk up to the repo-root
// vite.config.ts (which belongs to an unrelated sibling project).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
