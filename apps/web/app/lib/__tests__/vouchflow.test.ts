// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
const configure = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("@vouchflow/web", () => ({ Vouchflow: { configure } }));
import { resolveRpId } from "../vouchflow";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  configure.mockClear();
});

describe("configured passkey address", () => {
  it.each(["trustysquire.ai", "www.trustysquire.ai", "preview.trustysquire.ai"])(
    "keeps the same rpId on %s",
    (host) => {
      expect(resolveRpId("trustysquire.ai", host)).toBe("trustysquire.ai");
    },
  );
  it.each(["trustysquire.ai.evil.test", "eviltrustysquire.ai", "unrelated-preview.test"])(
    "refuses unmatched origin %s",
    (host) => {
      expect(() => resolveRpId("trustysquire.ai", host)).toThrow(
        "Open this approval on trustysquire.ai",
      );
    },
  );
  it.each([undefined, "", "https://trustysquire.ai", "trustysquire.ai/path"])(
    "refuses missing or invalid config %s",
    (config) => {
      expect(() => resolveRpId(config, "trustysquire.ai")).toThrow(
        "Passkey address is missing or invalid",
      );
    },
  );
  it("passes the configured rpId into the SDK", async () => {
    vi.stubEnv("NEXT_PUBLIC_VOUCHFLOW_API_KEY", "test-key");
    vi.stubEnv("NEXT_PUBLIC_VOUCHFLOW_RP_ID", "localhost");
    const { getVouchflow } = await import("../vouchflow");
    getVouchflow();
    expect(configure).toHaveBeenCalledWith(expect.objectContaining({ rpId: "localhost" }));
  });
});
