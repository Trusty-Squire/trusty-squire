// Regression: the Google-identity operator path must reuse the canonical
// profile directory in place — never clone it — because a filesystem clone
// of the seeded login (even a byte-identical one) does not reach a Google
// session Google itself honors. See operator-direct-identity.ts.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireDirectIdentityProfile,
  OperatorDirectIdentityAcquisitionInterruptedError,
} from "../operator-direct-identity.js";
import { BrowserController } from "../browser.js";

const dirs: string[] = [];

function fixture(): { profileDir: string; lockRoot: string } {
  const profileDir = mkdtempSync(join(tmpdir(), "ts-direct-identity-profile-"));
  const lockRoot = mkdtempSync(join(tmpdir(), "ts-direct-identity-locks-"));
  dirs.push(profileDir, lockRoot);
  writeFileSync(join(profileDir, "marker"), "the-real-logged-in-profile");
  return { profileDir, lockRoot };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireDirectIdentityProfile", () => {
  it("hands back the canonical profile directory itself — no clone is created", async () => {
    const { profileDir, lockRoot } = fixture();
    const lease = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    try {
      expect(lease.profileDir).toBe(profileDir);
    } finally {
      await lease.destroy();
    }
  });

  it("hands the acquired guard to BrowserController for its complete lifecycle", async () => {
    const { profileDir, lockRoot } = fixture();
    const directLease = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    const controller = new BrowserController({
      humanize: false,
      profileDir,
      profileOperationLease: directLease.takeProfileOperationLease(),
    });
    Object.assign(controller, { startWithProfileGuard: async () => undefined });
    try {
      await expect(controller.start()).resolves.toBeUndefined();
      await expect(
        acquireDirectIdentityProfile({ profileDir, lockRoot, deadline: Date.now() }),
      ).rejects.toBeInstanceOf(OperatorDirectIdentityAcquisitionInterruptedError);
    } finally {
      await controller.close();
      await directLease.destroy();
    }
    const next = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    await next.destroy();
  });

  it("serializes concurrent acquisitions: a second attempt fails fast without a deadline wait", async () => {
    const { profileDir, lockRoot } = fixture();
    const first = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    await expect(
      acquireDirectIdentityProfile({ profileDir, lockRoot, deadline: Date.now() }),
    ).rejects.toThrow(OperatorDirectIdentityAcquisitionInterruptedError);
    await first.destroy();
    const second = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    await second.destroy();
  });

  it("releases the lease on returnWarm/destroy/retain alike, unblocking the next acquisition", async () => {
    const { profileDir, lockRoot } = fixture();
    for (const finish of [
      (lease: Awaited<ReturnType<typeof acquireDirectIdentityProfile>>) =>
        lease.returnWarm("closed"),
      (lease: Awaited<ReturnType<typeof acquireDirectIdentityProfile>>) => lease.destroy(),
      (lease: Awaited<ReturnType<typeof acquireDirectIdentityProfile>>) => lease.retain(),
    ]) {
      const lease = await acquireDirectIdentityProfile({ profileDir, lockRoot });
      await finish(lease);
      const next = await acquireDirectIdentityProfile({ profileDir, lockRoot });
      await next.destroy();
    }
  });

  it("unblocks a waiting acquisition as soon as the holder releases", async () => {
    const { profileDir, lockRoot } = fixture();
    const first = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    const waiting = acquireDirectIdentityProfile({
      profileDir,
      lockRoot,
      deadline: Date.now() + 5_000,
    });
    let resolved = false;
    void waiting.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false);
    await first.destroy();
    const second = await waiting;
    expect(second.profileDir).toBe(profileDir);
    await second.destroy();
  });

  it("honors cancellation via AbortSignal without waiting for the deadline", async () => {
    const { profileDir, lockRoot } = fixture();
    const first = await acquireDirectIdentityProfile({ profileDir, lockRoot });
    const controller = new AbortController();
    const waiting = acquireDirectIdentityProfile({
      profileDir,
      lockRoot,
      deadline: Date.now() + 60_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "cancelled" });
    await first.destroy();
  });
});
