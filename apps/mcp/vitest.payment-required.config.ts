import { defineConfig } from "vitest/config";
import { REQUIRED_PAYMENT_SAFETY_FILES } from "./vitest.tiers";
import { MCP_TEST_RUNTIME } from "./vitest.shared";

export default defineConfig({
  test: {
    ...MCP_TEST_RUNTIME,
    include: REQUIRED_PAYMENT_SAFETY_FILES,
  },
});
