import { describe, expect, it } from "vitest";
import { brokerBusyStatus } from "../broker/status.js";

const idle = {
  maintenanceOwned: false,
  draining: false,
  ownsLiveBrowser: false,
  profileHolder: null,
  tabFamilies: 0,
};
const foreignHolder = { pid: 4242, host: "box", stale: false };

describe("the busy fold, computed where all four layers are visible", () => {
  it("is not busy when nothing holds the browser", () => {
    expect(brokerBusyStatus(idle)).toEqual({ busy: false, tabFamilies: 0 });
  });

  it("reports the maintenance window, which no other process can observe", () => {
    expect(brokerBusyStatus({ ...idle, maintenanceOwned: true })).toMatchObject({
      busy: true,
      layer: "maintenance",
      code: "maintenance",
    });
  });

  it("reports a draining identity cell as the same window", () => {
    expect(brokerBusyStatus({ ...idle, draining: true })).toMatchObject({
      busy: true,
      layer: "maintenance",
      detail: "Identity cell is draining",
    });
  });

  it("names a foreign profile holder", () => {
    expect(brokerBusyStatus({ ...idle, profileHolder: foreignHolder })).toMatchObject({
      busy: true,
      layer: "profile",
      code: "profile_busy",
      holder: { pid: 4242, host: "box" },
    });
  });

  it("does not call its own live Chrome a foreign process to close", () => {
    expect(
      brokerBusyStatus({ ...idle, ownsLiveBrowser: true, profileHolder: foreignHolder }),
    ).toEqual({ busy: false, tabFamilies: 0 });
  });

  it("ignores a reclaimable lock left by a dead holder", () => {
    expect(brokerBusyStatus({ ...idle, profileHolder: { ...foreignHolder, stale: true } })).toEqual(
      { busy: false, tabFamilies: 0 },
    );
  });

  it("does not call live tab families busy — the broker multiplexes them", () => {
    expect(brokerBusyStatus({ ...idle, ownsLiveBrowser: true, tabFamilies: 3 })).toEqual({
      busy: false,
      tabFamilies: 3,
    });
  });

  it("answers the maintenance window ahead of the profile lock connect just took", () => {
    // Across connect's window the broker has drained its Chrome and connect's
    // own login Chrome holds the lock: both layers are true, and the one that
    // tells the caller what to do is the window.
    expect(
      brokerBusyStatus({ ...idle, maintenanceOwned: true, profileHolder: foreignHolder }),
    ).toMatchObject({ busy: true, layer: "maintenance" });
  });
});
