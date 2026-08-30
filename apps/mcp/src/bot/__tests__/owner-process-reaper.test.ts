import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_PROFILE_SIGNATURE_FILE,
  OWNER_HELPER_MARKER_ENV,
  createOwnerEphemeralProfile,
  ensureOwnerProcessReaper,
  markOwnerBrowserLaunchTerminal,
  ownerBrowserLaunchState,
  ownerHelperIdentityState,
  reconcileOwnerBrowserLaunchAfterLeaderExit,
  spawnOwnerTrackedHelper,
  stopOwnerProcessReaper,
  sweepOrphanedOwnerProcesses,
  terminateOwnerBrowserLaunch,
  trackOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "../owner-process-reaper.js";
import {
  dispatchOperatorBrowserProcessTermination,
  operatorBrowserProcessMarkerState,
} from "../operator-browser-watchdog.js";

const cleanup: string[] = [];

afterEach(async () => {
  stopOwnerProcessReaper();
  vi.unstubAllEnvs();
  await Promise.all(
    cleanup.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("owner process startup sweep", () => {
  it.skipIf(process.platform !== "linux")(
    "reaps a helper from its pending exact-marker record",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
      const marker = "v1:pending-helper-test";
      const helper = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [OWNER_HELPER_MARKER_ENV]: marker },
      });
      helper.unref();
      try {
        await new Promise<void>((resolve, reject) => {
          helper.once("spawn", resolve);
          helper.once("error", reject);
        });
        await writeFile(
          join(root, "stale.json"),
          `${JSON.stringify({
            version: 4,
            token: "manifest",
            owner: { pid: 999_999_999, start_time: "1" },
            resources: [],
            launches: [],
            profiles: [],
            helpers: [{ marker, state: "pending" }],
          })}\n`,
        );

        await sweepOrphanedOwnerProcesses(root);
        await Promise.race([
          new Promise<void>((resolve) => helper.once("exit", () => resolve())),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("pending helper survived cleanup")), 2_000),
          ),
        ]);

        expect(helper.exitCode !== null || helper.signalCode !== null).toBe(true);
      } finally {
        if (helper.pid !== undefined) {
          try {
            process.kill(-helper.pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("persists exact helper custody before spawn and clears it on spawn failure", () => {
    const root = join(tmpdir(), `trusty-squire-reaper-test-${Date.now()}`);
    cleanup.push(root);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
    const reaper = ensureOwnerProcessReaper();
    expect(reaper).not.toBeNull();
    let atSpawn: { helpers: Array<{ marker: string; state?: string }> } | undefined;

    expect(() =>
      spawnOwnerTrackedHelper(
        "missing-helper",
        [],
        {},
        {
          spawn: (() => {
            atSpawn = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as typeof atSpawn;
            throw new Error("spawn failed");
          }) as never,
        },
      ),
    ).toThrow("spawn failed");

    expect(atSpawn?.helpers).toEqual([
      expect.objectContaining({ marker: expect.stringMatching(/^v1:/), state: "pending" }),
    ]);
    const afterFailure = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
      helpers: unknown[];
    };
    expect(afterFailure.helpers).toEqual([]);
  });

  it("reserves profile custody before directory creation and clears failed reservations", () => {
    const root = join(tmpdir(), `trusty-squire-reaper-test-${Date.now()}`);
    const profile = join(tmpdir(), `trusty-squire-operate-test-${Date.now()}`);
    const staging = join(tmpdir(), `.trusty-squire-profile-staging-test-${Date.now()}`);
    cleanup.push(root, profile, staging);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
    const reaper = ensureOwnerProcessReaper();
    expect(reaper).not.toBeNull();
    let atCreation: { profiles: Array<{ path: string; state?: string }> } | undefined;

    expect(() =>
      createOwnerEphemeralProfile({
        path: () => profile,
        stagingPath: () => staging,
        createDirectory: (path) => {
          expect(path).toBe(staging);
          atCreation = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as typeof atCreation;
          throw new Error("directory creation failed");
        },
      }),
    ).toThrow("directory creation failed");

    expect(atCreation?.profiles).toEqual([
      {
        path: profile,
        staging_path: staging,
        token: expect.any(String),
        state: "pending",
      },
    ]);
    const afterFailure = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
      profiles: unknown[];
    };
    expect(afterFailure.profiles).toEqual([]);
  });

  it("publishes an ephemeral profile only after its exact signature is present", () => {
    const root = join(tmpdir(), `trusty-squire-reaper-test-${Date.now()}`);
    cleanup.push(root);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
    const profile = createOwnerEphemeralProfile();
    cleanup.push(profile);
    const reaper = ensureOwnerProcessReaper();
    const signature = JSON.parse(
      readFileSync(join(profile, OWNER_PROFILE_SIGNATURE_FILE), "utf8"),
    ) as { path: string; token: string };
    const manifest = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
      profiles: Array<{ path: string; token: string; state: string; staging_path?: string }>;
    };

    expect(signature.path).toBe(profile);
    expect(manifest.profiles).toEqual([{ path: profile, token: signature.token, state: "ready" }]);
  });

  it("retains launch custody when an exact marker has ambiguous process identity", () => {
    const marker = "v1:1:ambiguous-descendant";
    expect(
      ownerBrowserLaunchState(marker, {
        readProcessIds: () => [42],
        readMarker: () => marker,
        readCommandState: () => "unknown",
      }),
    ).toBe("unknown");
  });

  it("retains browser and pending-helper custody when marker identity is unreadable", () => {
    expect(
      ownerBrowserLaunchState("v1:1:unreadable-browser", {
        readProcessIds: () => [42],
        readCommandState: () => "matching",
        readMarkerState: () => ({ state: "unknown" }),
      }),
    ).toBe("unknown");
    expect(
      ownerHelperIdentityState(
        { marker: "v1:unreadable-helper", state: "pending" },
        {
          readProcessIds: () => [42],
          readMarkerState: () => "unknown",
        },
      ),
    ).toBe("unknown");
  });

  it("distinguishes a missing process marker from an unreadable identity", () => {
    expect(
      operatorBrowserProcessMarkerState(42, () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }),
    ).toEqual({ state: "missing" });
    expect(
      operatorBrowserProcessMarkerState(42, () => {
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      }),
    ).toEqual({ state: "unknown" });
  });

  it("keeps launch cleanup blocked when the original leader exits before its marked descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    cleanup.push(root);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
    const marker = "v1:1:active-descendant";
    const reason = {
      kind: "max_lifetime" as const,
      lifetime_ms: 30_000,
      timeout_ms: 30_000,
    };

    trackOwnerBrowserLaunch(marker, join(root, "profile"));
    reconcileOwnerBrowserLaunchAfterLeaderExit(marker, () => "matching");

    await expect(dispatchOperatorBrowserProcessTermination(marker, reason)).resolves.toBe(false);
    markOwnerBrowserLaunchTerminal(marker);
    await expect(dispatchOperatorBrowserProcessTermination(marker, reason)).resolves.toBe(true);
    untrackOwnerBrowserLaunch(marker);
  });

  it("re-enumerates and kills a late exact-marker browser descendant", async () => {
    let phase = 0;
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    await expect(
      terminateOwnerBrowserLaunch("v1:1:late-descendant", {
        graceMs: 1,
        readProcessIds: () => (phase === 0 ? [11, 99] : phase === 1 ? [12, 99] : [99]),
        processMatches: (pid) => pid !== 99,
        kill: (pid, signal) => killed.push({ pid, signal }),
        wait: async () => {
          phase += 1;
        },
      }),
    ).resolves.toBe(true);

    expect(killed).toEqual([
      { pid: 11, signal: "SIGTERM" },
      { pid: 12, signal: "SIGKILL" },
    ]);
  });

  it("removes only an exactly signed Trusty Squire ephemeral profile", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const signed = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const signedPending = await mkdtemp(join(tmpdir(), ".trusty-squire-profile-staging-"));
    const signedPendingFinal = join(tmpdir(), `trusty-squire-operate-signed-pending-${Date.now()}`);
    const unsignedPending = await mkdtemp(join(tmpdir(), ".trusty-squire-profile-staging-"));
    const unsignedPendingFinal = join(
      tmpdir(),
      `trusty-squire-operate-unsigned-pending-${Date.now()}`,
    );
    const foreign = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    cleanup.push(root, signed, signedPending, unsignedPending, foreign);
    const token = "signed-profile-token";
    const pendingToken = "signed-pending-token";
    await writeFile(
      join(signed, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token, path: signed })}\n`,
    );
    await writeFile(
      join(foreign, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: "someone-else", path: foreign })}\n`,
    );
    await writeFile(
      join(signedPending, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: pendingToken, path: signedPendingFinal })}\n`,
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "stale.json"),
      `${JSON.stringify({
        version: 4,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [
          { path: signed, token, state: "ready" },
          {
            path: signedPendingFinal,
            staging_path: signedPending,
            token: pendingToken,
            state: "pending",
          },
          {
            path: unsignedPendingFinal,
            staging_path: unsignedPending,
            token: "unsigned-pending-token",
            state: "pending",
          },
          { path: foreign, token, state: "ready" },
        ],
        helpers: [],
      })}\n`,
    );

    await sweepOrphanedOwnerProcesses(root);

    expect(existsSync(signed)).toBe(false);
    expect(existsSync(signedPending)).toBe(false);
    expect(existsSync(unsignedPending)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(root, "stale.json"))).toBe(true);
    expect(await readFile(join(foreign, OWNER_PROFILE_SIGNATURE_FILE), "utf8")).toContain(
      "someone-else",
    );
  });
});
