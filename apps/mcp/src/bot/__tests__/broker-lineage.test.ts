import { afterEach, expect, it, vi } from "vitest";
import { forwarderId, requireLineageCredential } from "../broker/lineage.js";
afterEach(() => vi.unstubAllEnvs());
it("gives independent MCP processes distinct opaque lineages without configuration", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", undefined);
  const first = requireLineageCredential();
  const second = requireLineageCredential();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(forwarderId(first)).not.toBe(forwarderId(second));
});
it("preserves an explicit restart credential and refuses malformed credentials", () => {
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "a".repeat(43));
  expect(requireLineageCredential()).toBe("a".repeat(43));
  vi.stubEnv("TRUSTY_SQUIRE_FORWARDER_CREDENTIAL", "short");
  expect(() => requireLineageCredential()).toThrow("unguessable");
});
