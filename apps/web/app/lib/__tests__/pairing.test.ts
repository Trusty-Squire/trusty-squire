import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getEnrollmentState: vi.fn(),
  checkSupport: vi.fn(),
  enroll: vi.fn(),
}));

vi.mock("../vouchflow", () => ({ getVouchflow: () => client }));

import { pairDevice } from "../pairing";

beforeEach(() => {
  vi.clearAllMocks();
  client.checkSupport.mockResolvedValue({ platformAuthenticator: true, prf: true });
  client.enroll.mockResolvedValue({ deviceToken: "dev_1" });
});

describe("pairDevice", () => {
  it("does not create a second passkey when this browser is already enrolled", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: true, deviceId: "dev_1" });
    await pairDevice();
    expect(client.enroll).not.toHaveBeenCalled();
  });

  it("enrolls a browser that has no passkey yet", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: false, deviceId: null });
    await pairDevice();
    expect(client.enroll).toHaveBeenCalledWith({ userHandle: "__default__" });
  });
});
