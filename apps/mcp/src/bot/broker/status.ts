// "Is the browser in use", folded once, inside the broker.
//
// Every layer has its own word for busy and its own refusal code. Folding them
// from outside is what produces a confident answer about the wrong layer: a
// live socket does not say whose Chrome holds the profile lease, and the
// connect maintenance window is not observable at all from another process.
// This is the only place all four are visible at the same instant.

import type { StatusResult } from "./protocol.js";

export interface BrokerBusyInputs {
  /** A connect login owns the maintenance window on this broker. */
  maintenanceOwned: boolean;
  /** Custody is draining the identity cell. */
  draining: boolean;
  /** The Chrome on the served profile is this broker's own, and still live. */
  ownsLiveBrowser: boolean;
  /** Chrome's SingletonLock holder on the served profile. */
  profileHolder: { pid: number; host: string; stale: boolean } | null;
}

export function brokerBusyStatus(inputs: BrokerBusyInputs): StatusResult {
  if (inputs.maintenanceOwned)
    return {
      busy: true,
      code: "maintenance",
      detail: "Connect owns the browser maintenance window",
    };
  if (inputs.draining)
    return { busy: true, code: "maintenance", detail: "Identity cell is draining" };
  // A lock this broker's own live Chrome holds is custody working, not a
  // foreign process to close. Any other live holder is the profile layer.
  // Live tab families are not an input at all: the broker multiplexes them on
  // one shared Chrome, so a running family can never make this busy.
  const holder = inputs.profileHolder;
  if (!inputs.ownsLiveBrowser && holder !== null && !holder.stale)
    return {
      busy: true,
      code: "profile_busy",
      detail: "The Chrome profile lease is already held",
      holder: { pid: holder.pid, host: holder.host },
    };
  return { busy: false };
}
