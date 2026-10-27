import { describe, expect, it } from "vitest";
import { openApproval } from "../src/index.js";

describe("openApproval without a DOM", () => {
  it("rejects with no_browser so a server caller uses approvalPageUrl instead", async () => {
    await expect(
      openApproval({ id: "a", approveUrl: "https://trustysquire.ai/vault/fetch/a" }),
    ).rejects.toMatchObject({ code: "no_browser" });
  });
});
