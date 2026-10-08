import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  getEnrollmentState: vi.fn(),
  checkSupport: vi.fn(),
  enroll: vi.fn(),
}));
const apiPost = vi.hoisted(() => vi.fn());

vi.mock("../vouchflow", () => ({ getVouchflow: () => client }));
vi.mock("../api", () => ({ ApiError: class ApiError extends Error {}, apiPost }));

import { pairDevice, registerEnrolledDevice } from "../pairing";

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

  it("asks the SDK to recover a browser with no local record", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: false, deviceId: null });
    await pairDevice();
    expect(client.enroll).toHaveBeenCalledWith(undefined);
  });

  it("creates a new passkey only with the explicit forceNew option", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: true, deviceId: "dev_1" });
    await pairDevice({ forceNew: true });
    expect(client.enroll).toHaveBeenCalledWith({ forceNew: true });
  });

  it("claims a recovered device using its existing device token", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: true, deviceId: "existing_token" });
    apiPost.mockResolvedValue({});
    expect(await registerEnrolledDevice()).toBe(true);
    expect(apiPost).toHaveBeenCalledWith("/v1/vouchflow/devices", {
      device_token: "existing_token",
    });
  });

  it("does not turn a cancelled recovery into a new enrollment", async () => {
    client.getEnrollmentState.mockResolvedValue({ enrolled: false, deviceId: null });
    const recoveryRequired = Object.assign(new Error("Recovery required"), {
      code: "passkey_recovery_required",
    });
    client.enroll.mockRejectedValue(recoveryRequired);
    await expect(pairDevice()).rejects.toBe(recoveryRequired);
    expect(client.enroll).toHaveBeenCalledTimes(1);
    expect(client.enroll).toHaveBeenCalledWith(undefined);
  });
});
