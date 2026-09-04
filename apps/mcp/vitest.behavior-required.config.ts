import { defineConfig } from "vitest/config";
import { REQUIRED_BEHAVIOR_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: REQUIRED_BEHAVIOR_FILES,
  },
});
