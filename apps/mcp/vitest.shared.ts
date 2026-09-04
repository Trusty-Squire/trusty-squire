// Runtime/pool settings shared by the complete, required, and slow configs.
export const MCP_TEST_RUNTIME = {
  // Containment: no test may resolve the developer's real home, which on the
  // dev box holds the live servers' session.json, Chrome profile, and instance
  // records. See src/__tests__/setup/isolate-config-home.ts.
  setupFiles: ["./src/__tests__/setup/isolate-config-home.ts"],
  // These suites exercise real browser and process lifecycles. A fresh fork
  // per file keeps their bounded timers independent while one worker avoids
  // exhausting constrained CI runners.
  pool: "forks",
  poolOptions: {
    forks: {
      minForks: 1,
      maxForks: 1,
    },
  },
};
