import { defineConfig } from "vitest/config";
import {
  MCP_TEST_INCLUDE_GLOBS,
  QUARANTINED_FILES,
  REQUIRED_PAYMENT_SAFETY_FILES,
  SLOW_POST_MERGE_FILES,
} from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: MCP_TEST_INCLUDE_GLOBS,
    exclude: [...SLOW_POST_MERGE_FILES, ...REQUIRED_PAYMENT_SAFETY_FILES, ...QUARANTINED_FILES],
  },
});
