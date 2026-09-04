import { defineConfig } from "vitest/config";
import { SLOW_POST_MERGE_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: SLOW_POST_MERGE_FILES,
  },
});
