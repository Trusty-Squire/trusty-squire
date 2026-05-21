import { defineConfig } from "vitest/config";

// apps/api tests open fastify servers, prisma clients, and short-URL stores.
// Some leave dangling timers vitest's threads pool can't reap, causing the
// worker-terminate timeout that hangs CI. Forks pool spawns a fresh process
// per test file so OS cleanup reaps everything when the test finishes.
export default defineConfig({
  test: {
    pool: "forks",
  },
});
