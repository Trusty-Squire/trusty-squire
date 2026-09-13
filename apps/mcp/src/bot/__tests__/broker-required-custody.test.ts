import { expect, it, vi } from "vitest";
import { startProvisionSession, type SessionStartPorts } from "../session/lifecycle.js";
it("refuses operator startup outside broker custody without launching or observing a page", async () => {
  const observeSession = vi.fn();
  await expect(
    startProvisionSession({ serviceUrl: "https://example.test" }, {
      observeSession,
      compactV2StartMetadata: vi.fn(),
    } as SessionStartPorts),
  ).rejects.toThrow("requires broker browser custody");
  expect(observeSession).not.toHaveBeenCalled();
});
