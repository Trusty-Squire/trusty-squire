// The shared-broker ceremony exposure must never start a noVNC rig it cannot
// PROVE is ours: the holder's XAUTHORITY has to be a `tsq-login-` private
// rig the broker minted. Any other state — no holder at all, no display
// variables, a foreign Xauthority — skips the exposure silently (the operator
// is assumed to be looking at the screen themselves, or the broker runs
// headless and the user follows the confirm tab another way).

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProfileOperationGuard } from "../profile.js";
import { exposeSharedBrokerCeremonyDisplay } from "../google-login.js";

const dirs: string[] = [];
const leases: { release: () => void }[] = [];

afterEach(async () => {
  leases.splice(0).forEach((lease) => lease.release());
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempProfile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ts-ceremony-exposure-"));
  dirs.push(root);
  const profile = join(root, "profile");
  await mkdir(profile, { recursive: true, mode: 0o700 });
  return profile;
}

describe("exposeSharedBrokerCeremonyDisplay", () => {
  it("skips exposure when no process holds the profile", async () => {
    const profile = await tempProfile();
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });

  it("skips exposure when the holder's environment has no owned login rig", async () => {
    const profile = await tempProfile();
    const root = dirname(profile);
    // This process holds the profile lease, but its environment carries no
    // tsq-login- XAUTHORITY (the test sandbox has none), so there is nothing
    // to expose — and certainly no rig the helper should adopt.
    const lease = acquireProfileOperationGuard(profile, root);
    leases.push(lease);
    await expect(exposeSharedBrokerCeremonyDisplay(profile, "test")).resolves.toBeNull();
  });
});
