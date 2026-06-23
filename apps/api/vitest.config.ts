import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// apps/api tests open fastify servers, prisma clients, and short-URL stores.
// Some leave dangling timers vitest's threads pool can't reap, causing the
// worker-terminate timeout that hangs CI. Forks pool spawns a fresh process
// per test file so OS cleanup reaps everything when the test finishes.
export default defineConfig({
  resolve: {
    alias: {
      // API tests should exercise the workspace source, not the last built
      // dist artifact. Otherwise package-surface changes in @trusty-squire/vault
      // require a manual `pnpm -F @trusty-squire/vault build` before API tests,
      // which hides integration regressions behind stale generated JS.
      "@trusty-squire/vault": fileURLToPath(
        new URL("../../packages/vault/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    pool: "forks",
  },
});
