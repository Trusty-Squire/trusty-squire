import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
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
  startOwnerProcessReaper,
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
    "does not publish a reaper when worker spawn throws",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);

      const reaper = startOwnerProcessReaper(
        { rootDir: root },
        {
          spawn: (() => {
            throw new Error("spawn failed");
          }) as never,
        },
      );

      expect(reaper).toBeNull();
      expect(() =>
        trackOwnerBrowserLaunch("v1:1:worker-spawn-failed", join(root, "profile"), {
          ensureReaper: () => reaper,
        }),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not publish a reaper after an asynchronous spawn error",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      const worker = Object.assign(new EventEmitter(), {
        pid: undefined,
        unref: () => worker,
        kill: () => true,
      }) as unknown as ChildProcess;

      const reaper = startOwnerProcessReaper(
        { rootDir: root },
        {
          spawn: (() => {
            queueMicrotask(() => worker.emit("error", new Error("spawn failed")));
            return worker;
          }) as never,
        },
      );
      await Promise.resolve();

      expect(reaper).toBeNull();
      expect(() =>
        trackOwnerBrowserLaunch("v1:1:worker-spawn-error", join(root, "profile"), {
          ensureReaper: () => reaper,
        }),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "does not spawn a missing worker entrypoint",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      const spawnWorker = vi.fn();

      expect(
        startOwnerProcessReaper(
          { rootDir: root, workerPath: join(root, "missing-worker.mjs") },
          { spawn: spawnWorker as never },
        ),
      ).toBeNull();
      expect(spawnWorker).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects a worker that acknowledges readiness and exits immediately",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      const workerPath = join(root, "early-exit-worker.mjs");
      await writeFile(
        workerPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ version: 1, token: process.argv[4], pid: process.pid }) + "\\n");\n`,
      );

      expect(startOwnerProcessReaper({ rootDir: root, workerPath })).toBeNull();
      expect(() =>
        trackOwnerBrowserLaunch("v1:1:worker-exited-early", join(root, "profile"), {
          ensureReaper: () => null,
        }),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "rejects later registrations after the ready worker exits",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      const workerPath = join(root, "later-exit-worker.mjs");
      await writeFile(
        workerPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[3], JSON.stringify({ version: 1, token: process.argv[4], pid: process.pid }) + "\\n");\nsetTimeout(() => process.exit(0), 100);\n`,
      );

      expect(startOwnerProcessReaper({ rootDir: root, workerPath })).not.toBeNull();
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 200));

      expect(() =>
        trackOwnerBrowserLaunch("v1:1:worker-exited-later", join(root, "profile")),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

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
        readUidState: () => "matching",
      }),
    ).toBe("unknown");
    expect(
      ownerHelperIdentityState(
        { marker: "v1:unreadable-helper", state: "pending" },
        {
          readProcessIds: () => [42],
          readMarkerState: () => "unknown",
          readUidState: () => "matching",
        },
      ),
    ).toBe("unknown");
  });

  it("ignores unreadable marker identities owned by another user", () => {
    expect(
      ownerBrowserLaunchState("v1:1:local-browser", {
        readProcessIds: () => [42],
        readCommandState: () => "matching",
        readMarkerState: () => ({ state: "unknown" }),
        readUidState: () => "stale",
      }),
    ).toBe("stale");
    expect(
      ownerHelperIdentityState(
        { marker: "v1:local-helper", state: "pending" },
        {
          readProcessIds: () => [42],
          readMarkerState: () => "unknown",
          readUidState: () => "stale",
        },
      ),
    ).toBe("stale");
  });

  it.skipIf(process.platform !== "linux")(
    "refuses local browser custody when the durable reaper is unavailable",
    () => {
      expect(() =>
        trackOwnerBrowserLaunch("v1:1:unowned-browser", "/isolated-profile", {
          ensureReaper: () => null,
        }),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

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
    const retained = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const unsignedPending = await mkdtemp(join(tmpdir(), ".trusty-squire-profile-staging-"));
    const unsignedPendingFinal = join(
      tmpdir(),
      `trusty-squire-operate-unsigned-pending-${Date.now()}`,
    );
    const foreign = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    cleanup.push(root, signed, signedPending, retained, unsignedPending, foreign);
    const token = "signed-profile-token";
    const pendingToken = "signed-pending-token";
    const retainedToken = "live-profile-token";
    await writeFile(
      join(signed, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token, path: signed })}\n`,
    );
    await writeFile(
      join(foreign, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: "someone-else", path: foreign })}\n`,
    );
    await writeFile(
      join(retained, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: retainedToken, path: retained })}\n`,
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
        resources: [
          {
            host: "foreign-host.invalid",
            pid: 999_999_998,
            start_time: "1",
            user_data_dir: retained,
          },
        ],
        launches: [],
        profiles: [
          { path: signed, token, state: "ready" },
          { path: retained, token: retainedToken, state: "ready" },
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
    expect(existsSync(retained)).toBe(true);
    expect(existsSync(signedPending)).toBe(false);
    expect(existsSync(unsignedPending)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(root, "stale.json"))).toBe(true);
    expect(await readFile(join(foreign, OWNER_PROFILE_SIGNATURE_FILE), "utf8")).toContain(
      "someone-else",
    );
  });
});
