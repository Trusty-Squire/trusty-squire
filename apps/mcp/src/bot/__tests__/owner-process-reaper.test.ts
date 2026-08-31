import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_PROFILE_SIGNATURE_FILE,
  OWNER_ARTIFACT_SIGNATURE_FILE,
  OWNER_ARTIFACT_ROOT_SIGNATURE_FILE,
  OWNER_HELPER_MARKER_ENV,
  createOwnerEphemeralProfile,
  ensureOwnerProcessReaper,
  markOwnerBrowserLaunchTerminal,
  ownerBrowserLaunchState,
  ownerHelperIdentityState,
  ownerTrackedHelperState,
  reconcileOwnerBrowserLaunchAfterLeaderExit,
  runOwnerProcessReaperWorker,
  removeOwnerSessionArtifact,
  spawnOwnerTrackedHelper,
  startOwnerProcessReaper,
  stopOwnerProcessReaper,
  sweepOrphanedOwnerProcesses,
  terminateOwnerBrowserLaunch,
  trackOwnerSessionArtifact,
  trackOwnerBrowserLaunch,
  untrackOwnerBrowserLaunch,
} from "../owner-process-reaper.js";
import {
  dispatchOperatorBrowserProcessTermination,
  operatorBrowserProcessMarkerState,
} from "../operator-browser-watchdog.js";

const cleanup: string[] = [];
const testRequire = createRequire(import.meta.url);

function processIsGone(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const state = close < 0 ? undefined : stat.slice(close + 2).split(" ")[0];
    return state === "Z" || state === "X";
  } catch {
    return true;
  }
}

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
    "escalates an unready detached worker through exact-marker SIGKILL",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_READY_TIMEOUT_MS", "200");
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "20");
      const workerPath = join(root, "unready-worker.mjs");
      const pidPath = join(root, "unready-worker.pid");
      await writeFile(
        workerPath,
        `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\nprocess.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\n`,
      );

      expect(startOwnerProcessReaper({ rootDir: root, workerPath })).toBeNull();
      const pid = Number(readFileSync(pidPath, "utf8"));
      await vi.waitFor(() => expect(processIsGone(pid)).toBe(true), { timeout: 1_000 });
    },
  );

  it.skipIf(process.platform !== "linux")(
    "restarts a ready worker immediately while live custody remains registered",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const workerPath = join(root, "later-exit-worker.mjs");
      await writeFile(
        workerPath,
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst countPath = new URL("./worker-count", import.meta.url);\nconst count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;\nwriteFileSync(countPath, String(count));\nwriteFileSync(new URL(\`./worker-\${count}.pid\`, import.meta.url), String(process.pid));\nwriteFileSync(process.argv[3], JSON.stringify({ version: 1, token: process.argv[4], pid: process.pid }) + "\\n");\nsetInterval(() => undefined, 1000);\n`,
      );

      const reaper = startOwnerProcessReaper({ rootDir: root, workerPath });
      expect(reaper).not.toBeNull();
      const helper = spawnOwnerTrackedHelper(process.execPath, [
        "-e",
        "setInterval(() => undefined, 1000)",
      ]);
      try {
        expect(ownerTrackedHelperState(helper)).toBe("matching");
        expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("2");
        const firstWorkerPid = Number(readFileSync(join(root, "worker-1.pid"), "utf8"));
        process.kill(firstWorkerPid, "SIGKILL");
        await vi.waitFor(() => expect(processIsGone(firstWorkerPid)).toBe(true), {
          timeout: 2_000,
        });
        await vi.waitFor(
          () => expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("3"),
          { timeout: 5_000 },
        );

        expect(reaper!.isAvailable()).toBe(true);
        expect(ownerTrackedHelperState(helper)).toBe("matching");
        const manifest = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
          helpers: unknown[];
        };
        expect(manifest.helpers).toHaveLength(1);
      } finally {
        if (helper.pid !== undefined) {
          try {
            process.kill(-helper.pid, "SIGKILL");
          } catch {}
        }
      }
    },
    15_000,
  );

  it.skipIf(process.platform !== "linux")(
    "keeps live custody intact while retrying worker replacement",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_READY_TIMEOUT_MS", "500");
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "5");
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_RECOVERY_BACKOFF_MS", "5");
      const workerPath = join(root, "failed-replacement-worker.mjs");
      await writeFile(
        workerPath,
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst countPath = new URL("./worker-count", import.meta.url);\nconst count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;\nwriteFileSync(countPath, String(count));\nif (count <= 2 || count >= 5) {\n  writeFileSync(process.argv[3], JSON.stringify({ version: 1, token: process.argv[4], pid: process.pid }) + "\\n");\n}\nif (count === 1) setTimeout(() => process.exit(0), 600);\nelse setInterval(() => undefined, 1000);\n`,
      );

      let launchAttempt = 0;
      const reaper = startOwnerProcessReaper(
        { rootDir: root, workerPath },
        {
          beforeWorkerLaunch: () => {
            launchAttempt += 1;
            if (launchAttempt === 3) throw new Error("injected recovery launch failure");
          },
        },
      );
      expect(reaper).not.toBeNull();
      const helper = spawnOwnerTrackedHelper(process.execPath, [
        "-e",
        'process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000)',
      ]);
      try {
        await vi.waitFor(() => expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("5"), {
          timeout: 5_000,
        });
        expect(ownerTrackedHelperState(helper)).toBe("matching");
        expect(reaper!.isAvailable()).toBe(true);
      } finally {
        if (helper.pid !== undefined) {
          try {
            process.kill(-helper.pid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps a detached custodian through replacement failure and owner SIGKILL",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      const moduleUrl = new URL("../owner-process-reaper.ts", import.meta.url).href;
      const workerPath = fileURLToPath(
        new URL("../owner-process-reaper-worker.ts", import.meta.url),
      );
      const unreadyWorkerPath = join(root, "unready-replacement.mjs");
      const ownerPath = join(root, "owner.ts");
      const readyPath = join(root, "owner-ready.json");
      const errorPath = join(root, "owner-error.txt");
      await writeFile(
        unreadyWorkerPath,
        `process.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\n`,
      );
      await writeFile(
        ownerPath,
        `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nvoid (async () => {\n  try {\n    const { spawnOwnerTrackedHelper, startOwnerProcessReaper } = await import(${JSON.stringify(moduleUrl)});\n    process.env.TRUSTY_SQUIRE_REAPER_READY_TIMEOUT_MS = "2000";\n    process.env.TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS = "20";\n    process.env.TRUSTY_SQUIRE_REAPER_POLL_MS = "10";\n    process.env.TRUSTY_SQUIRE_REAPER_RECOVERY_BACKOFF_MS = "500";\n    let workerCount = 0;\n    const spawnWorker = (command, args, options) => {\n      workerCount += 1;\n      const child = spawn(command, workerCount <= 2 ? args : [${JSON.stringify(unreadyWorkerPath)}, ...args.slice(-3)], options);\n      if (child.pid !== undefined) writeFileSync(${JSON.stringify(root)} + "/worker-" + workerCount + ".pid", String(child.pid));\n      return child;\n    };\n    const reaper = startOwnerProcessReaper(\n      { rootDir: ${JSON.stringify(root)}, workerPath: ${JSON.stringify(workerPath)} },\n      { spawn: spawnWorker },\n    );\n    if (reaper === null) throw new Error("reaper unavailable");\n    const helper = spawnOwnerTrackedHelper(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"]);\n    writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ helper: helper.pid, owner: process.pid }) + "\\n");\n    process.env.TRUSTY_SQUIRE_REAPER_READY_TIMEOUT_MS = "100";\n    setInterval(() => undefined, 1000);\n  } catch (error) {\n    writeFileSync(${JSON.stringify(errorPath)}, error instanceof Error ? error.stack ?? error.message : String(error));\n    process.exit(1);\n  }\n})();\n`,
      );
      const owner = spawn(process.execPath, [testRequire.resolve("tsx/cli"), ownerPath], {
        detached: true,
        stdio: ["ignore", "ignore", "inherit"],
      });
      let helperPid: number | undefined;
      let ownerRuntimePid: number | undefined;
      let backupPid: number | undefined;
      let failedReplacementPid: number | undefined;
      try {
        await vi.waitFor(() => expect(existsSync(readyPath) || existsSync(errorPath)).toBe(true), {
          timeout: 10_000,
        });
        if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, "utf8"));
        const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
          helper: number;
          owner: number;
        };
        helperPid = ready.helper;
        ownerRuntimePid = ready.owner;
        const firstPid = Number(readFileSync(join(root, "worker-1.pid"), "utf8"));
        backupPid = Number(readFileSync(join(root, "worker-2.pid"), "utf8"));
        process.kill(firstPid, "SIGKILL");
        await vi.waitFor(() => expect(existsSync(join(root, "worker-3.pid"))).toBe(true), {
          timeout: 2_000,
        });
        failedReplacementPid = Number(readFileSync(join(root, "worker-3.pid"), "utf8"));
        await vi.waitFor(() => expect(processIsGone(failedReplacementPid!)).toBe(true), {
          timeout: 1_000,
        });

        process.kill(ownerRuntimePid, "SIGKILL");
        await vi.waitFor(() => expect(processIsGone(helperPid!)).toBe(true), { timeout: 2_000 });
        await vi.waitFor(() => expect(processIsGone(backupPid!)).toBe(true), { timeout: 2_000 });
      } finally {
        for (const pid of [
          owner.pid,
          ownerRuntimePid,
          helperPid,
          backupPid,
          failedReplacementPid,
        ]) {
          if (pid === undefined || processIsGone(pid)) continue;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    },
    25_000,
  );

  it("retries an invalid manifest until confirmed deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    cleanup.push(root);
    const manifestPath = join(root, "transient.json");
    await writeFile(manifestPath, "{\n");
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_POLL_MS", "5");
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const startTime = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    let ready = false;
    const worker = runOwnerProcessReaperWorker(manifestPath, () => {
      ready = true;
      rmSync(manifestPath, { force: true });
    });

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 4,
        token: "transient-read",
        owner: { pid: process.pid, start_time: startTime },
        resources: [],
        launches: [],
        profiles: [],
        helpers: [],
      })}\n`,
    );

    await worker;
    expect(ready).toBe(true);
  });

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

  it.skipIf(process.platform !== "linux")(
    "reaps a surviving exact-marker helper group when post-spawn binding fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      cleanup.push(root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const survivorPath = join(root, "survivor.pid");
      const helperPath = join(root, "leader.mjs");
      await writeFile(
        helperPath,
        `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst survivor = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" });\nwriteFileSync(process.argv[2], String(survivor.pid));\nsetTimeout(() => process.exit(0), 50);\n`,
      );
      const reaper = ensureOwnerProcessReaper();
      expect(reaper).not.toBeNull();
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      reaper!.bindHelper = () => {
        const deadline = Date.now() + 1_000;
        while (!existsSync(survivorPath) && Date.now() < deadline) {
          Atomics.wait(waitBuffer, 0, 0, 5);
        }
        Atomics.wait(waitBuffer, 0, 0, 100);
        throw new Error("bind failed");
      };
      let leader: ChildProcess | undefined;
      let survivorPid: number | undefined;
      try {
        expect(() =>
          spawnOwnerTrackedHelper(
            process.execPath,
            [helperPath, survivorPath],
            {},
            {
              spawn: ((...args: Parameters<typeof spawn>) => {
                leader = spawn(...args);
                return leader;
              }) as typeof spawn,
            },
          ),
        ).toThrow("bind failed");

        survivorPid = Number(readFileSync(survivorPath, "utf8"));
        const processIsGone = (pid: number): boolean => {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            const close = stat.lastIndexOf(")");
            const state = close < 0 ? undefined : stat.slice(close + 2).split(" ")[0];
            return state === "Z" || state === "X";
          } catch {
            return true;
          }
        };
        await vi.waitFor(() => expect(processIsGone(survivorPid!)).toBe(true), { timeout: 2_000 });
        await vi.waitFor(() => {
          const manifest = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
            helpers: unknown[];
          };
          expect(manifest.helpers).toEqual([]);
        });
      } finally {
        if (leader?.pid !== undefined) {
          try {
            process.kill(-leader.pid, "SIGKILL");
          } catch {}
        }
        if (survivorPid !== undefined) {
          try {
            process.kill(survivorPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it("reserves profile custody before directory creation and clears failed reservations", () => {
    const root = join(tmpdir(), `trusty-squire-reaper-test-${Date.now()}`);
    const profile = join(tmpdir(), `trusty-squire-operate-test-${Date.now()}`);
    const staging = join(tmpdir(), `.trusty-squire-profile-staging-test-${Date.now()}`);
    const reservation = join(
      tmpdir(),
      `.trusty-squire-profile-reservation-test-${Date.now()}.json`,
    );
    cleanup.push(root, profile, staging, reservation);
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_DIR", root);
    const reaper = ensureOwnerProcessReaper();
    expect(reaper).not.toBeNull();
    let atCreation: { profiles: Array<{ path: string; state?: string }> } | undefined;

    expect(() =>
      createOwnerEphemeralProfile({
        path: () => profile,
        stagingPath: () => staging,
        reservationPath: () => reservation,
        createDirectory: (path) => {
          expect(path).toBe(staging);
          expect(existsSync(reservation)).toBe(true);
          atCreation = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as typeof atCreation;
          throw new Error("directory creation failed");
        },
      }),
    ).toThrow("directory creation failed");

    expect(atCreation?.profiles).toEqual([
      {
        path: profile,
        staging_path: staging,
        reservation_path: reservation,
        token: expect.any(String),
        state: "pending",
      },
    ]);
    const afterFailure = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
      profiles: unknown[];
    };
    expect(afterFailure.profiles).toEqual([]);
    expect(existsSync(reservation)).toBe(false);
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

  it("retains helper-group custody when a descendant PGID is unreadable", () => {
    expect(
      ownerHelperIdentityState(
        {
          pid: 41,
          start_time: "1",
          marker: "v1:unreadable-helper-group",
          process_group_id: 77,
        },
        {
          readProcessIds: () => [42],
          readProcessGroupId: () => "unknown",
          readRunningState: (pid) => (pid === 42 ? "matching" : "stale"),
          readBirthState: () => "stale",
          readMarkerState: () => "matching",
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
    const reservedPending = await mkdtemp(join(tmpdir(), ".trusty-squire-profile-staging-"));
    const reservedPendingFinal = join(
      tmpdir(),
      `trusty-squire-operate-reserved-pending-${Date.now()}`,
    );
    const reservedPendingProof = join(
      tmpdir(),
      `.trusty-squire-profile-reservation-test-${Date.now()}.json`,
    );
    const retained = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const unsignedPending = await mkdtemp(join(tmpdir(), ".trusty-squire-profile-staging-"));
    const unsignedPendingFinal = join(
      tmpdir(),
      `trusty-squire-operate-unsigned-pending-${Date.now()}`,
    );
    const foreign = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    cleanup.push(
      root,
      signed,
      signedPending,
      reservedPending,
      reservedPendingProof,
      retained,
      unsignedPending,
      foreign,
    );
    const token = "signed-profile-token";
    const pendingToken = "signed-pending-token";
    const reservedPendingToken = "reserved-pending-token";
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
    await writeFile(
      reservedPendingProof,
      `${JSON.stringify({
        version: 1,
        token: reservedPendingToken,
        path: reservedPendingFinal,
        staging_path: reservedPending,
      })}\n`,
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
            path: reservedPendingFinal,
            staging_path: reservedPending,
            reservation_path: reservedPendingProof,
            token: reservedPendingToken,
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
    expect(existsSync(reservedPending)).toBe(false);
    expect(existsSync(reservedPendingProof)).toBe(false);
    expect(existsSync(unsignedPending)).toBe(true);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(root, "stale.json"))).toBe(true);
    expect(await readFile(join(foreign, OWNER_PROFILE_SIGNATURE_FILE), "utf8")).toContain(
      "someone-else",
    );
  });

  it("isolates profile removal failures and retries retained exact custody", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const retained = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const removed = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    cleanup.push(root, retained, removed);
    const retainedToken = "retained-cleanup-token";
    const removedToken = "removed-cleanup-token";
    await writeFile(
      join(retained, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: retainedToken, path: retained })}\n`,
    );
    await writeFile(
      join(removed, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: removedToken, path: removed })}\n`,
    );
    await writeFile(
      join(root, "stale.json"),
      `${JSON.stringify({
        version: 4,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [
          { path: retained, token: retainedToken, state: "ready" },
          { path: removed, token: removedToken, state: "ready" },
        ],
        helpers: [],
      })}\n`,
    );

    await expect(
      sweepOrphanedOwnerProcesses(root, {
        removePath: (path, options) => {
          if (path === retained) {
            throw Object.assign(new Error("profile busy"), { code: "EBUSY" });
          }
          rmSync(path, options);
        },
      }),
    ).resolves.toBe(0);

    expect(existsSync(retained)).toBe(true);
    expect(existsSync(removed)).toBe(false);
    expect(existsSync(join(root, "stale.json"))).toBe(true);

    await sweepOrphanedOwnerProcesses(root);
    expect(existsSync(retained)).toBe(false);
    expect(existsSync(join(root, "stale.json"))).toBe(false);
  });

  it("retains manifests when tracked profile or artifact paths are unreadable", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const profile = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const artifactParent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
    const artifactToken = "unreadable-artifact-token";
    const artifactRoot = join(artifactParent, `.trusty-squire-owner-${artifactToken}`);
    const artifact = join(artifactRoot, "session");
    cleanup.push(root, profile, artifactParent);
    await writeFile(
      join(profile, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: "profile-token", path: profile })}\n`,
    );
    await mkdir(artifactRoot, { mode: 0o700 });
    await mkdir(artifact, { mode: 0o700 });
    await writeFile(
      join(artifactRoot, OWNER_ARTIFACT_ROOT_SIGNATURE_FILE),
      `${JSON.stringify({
        version: 1,
        token: artifactToken,
        path: artifactRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(artifact, OWNER_ARTIFACT_SIGNATURE_FILE),
      `${JSON.stringify({
        version: 1,
        token: artifactToken,
        path: artifact,
        root_path: artifactRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    const manifestPath = join(root, "unreadable.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 5,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [{ path: profile, token: "profile-token", state: "ready" }],
        helpers: [],
        artifacts: [
          { path: artifact, root_path: artifactRoot, token: artifactToken, state: "ready" },
        ],
      })}\n`,
    );

    await sweepOrphanedOwnerProcesses(root, {
      readPathState: (path) => (path === profile || path === artifact ? "unknown" : "matching"),
    });

    expect(existsSync(profile)).toBe(true);
    expect(existsSync(artifact)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("retains exact custody when a tracked signature cannot be read", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const profile = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const signaturePath = join(profile, OWNER_PROFILE_SIGNATURE_FILE);
    const manifestPath = join(root, "unreadable-signature.json");
    cleanup.push(root, profile);
    await writeFile(
      signaturePath,
      `${JSON.stringify({ version: 1, token: "profile-token", path: profile })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 5,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [{ path: profile, token: "profile-token", state: "ready" }],
        helpers: [],
        artifacts: [],
      })}\n`,
    );
    chmodSync(signaturePath, 0o000);

    await sweepOrphanedOwnerProcesses(root);

    expect(existsSync(profile)).toBe(true);
    expect(existsSync(manifestPath)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")(
    "persists and releases an exact session artifact descriptor",
    async () => {
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
      const artifact = join(parent, "session");
      cleanup.push(root, parent);
      const reaper = startOwnerProcessReaper({ rootDir: root });
      expect(reaper).not.toBeNull();

      const ownedArtifact = trackOwnerSessionArtifact(artifact);
      const ownerRoot = join(ownedArtifact, "..");

      const signature = JSON.parse(
        readFileSync(join(ownedArtifact, OWNER_ARTIFACT_SIGNATURE_FILE), "utf8"),
      ) as { token: string; path: string; root_path: string };
      const rootSignature = JSON.parse(
        readFileSync(join(ownerRoot, OWNER_ARTIFACT_ROOT_SIGNATURE_FILE), "utf8"),
      ) as { token: string; path: string };
      const tracked = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
        artifacts: Array<{ path: string; root_path: string; token: string; state: string }>;
      };
      expect(signature.path).toBe(ownedArtifact);
      expect(signature.root_path).toBe(ownerRoot);
      expect(rootSignature).toEqual({
        version: 1,
        token: signature.token,
        path: ownerRoot,
        owner_token: reaper!.token,
      });
      expect(tracked.artifacts).toEqual([
        {
          path: ownedArtifact,
          root_path: ownerRoot,
          token: signature.token,
          state: "ready",
        },
      ]);

      removeOwnerSessionArtifact(artifact);
      expect(existsSync(ownerRoot)).toBe(false);
      const released = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
        artifacts: unknown[];
      };
      expect(released.artifacts).toEqual([]);
    },
  );

  it("removes only exactly reserved or signed session artifacts", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
    const signedToken = "signed-artifact-token";
    const signedRoot = join(parent, `.trusty-squire-owner-${signedToken}`);
    const signed = join(signedRoot, "signed");
    const foreignRoot = join(parent, `.trusty-squire-owner-foreign-artifact-token`);
    const foreign = join(foreignRoot, "foreign");
    const pendingToken = "pending-artifact-token";
    const pendingRoot = join(parent, `.trusty-squire-owner-${pendingToken}`);
    const pending = join(pendingRoot, "pending");
    const reservation = join(root, `.trusty-squire-artifact-reservation-${pendingToken}.json`);
    cleanup.push(root, parent);
    await mkdir(signedRoot, { mode: 0o700 });
    await mkdir(signed, { mode: 0o700 });
    await mkdir(foreignRoot, { mode: 0o700 });
    await mkdir(foreign, { mode: 0o700 });
    await mkdir(pendingRoot, { mode: 0o700 });
    await mkdir(pending, { mode: 0o700 });
    for (const [path, token] of [
      [signedRoot, signedToken],
      [foreignRoot, "foreign-artifact-token"],
      [pendingRoot, pendingToken],
    ] as const) {
      await writeFile(
        join(path, OWNER_ARTIFACT_ROOT_SIGNATURE_FILE),
        `${JSON.stringify({ version: 1, token, path, owner_token: "manifest" })}\n`,
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(signed, OWNER_ARTIFACT_SIGNATURE_FILE),
      `${JSON.stringify({
        version: 1,
        token: signedToken,
        path: signed,
        root_path: signedRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(foreign, OWNER_ARTIFACT_SIGNATURE_FILE),
      `${JSON.stringify({
        version: 1,
        token: "foreign-token",
        path: foreign,
        root_path: foreignRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      reservation,
      `${JSON.stringify({
        version: 1,
        token: pendingToken,
        path: pending,
        root_path: pendingRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(root, "stale-artifacts.json"),
      `${JSON.stringify({
        version: 5,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [],
        helpers: [],
        artifacts: [
          { path: signed, root_path: signedRoot, token: signedToken, state: "ready" },
          {
            path: foreign,
            root_path: foreignRoot,
            token: "foreign-artifact-token",
            state: "ready",
          },
          {
            path: pending,
            root_path: pendingRoot,
            token: pendingToken,
            state: "pending",
            reservation_path: reservation,
          },
        ],
      })}\n`,
    );

    await sweepOrphanedOwnerProcesses(root);

    expect(existsSync(signed)).toBe(false);
    expect(existsSync(signedRoot)).toBe(false);
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(pendingRoot)).toBe(false);
    expect(existsSync(reservation)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(join(root, "stale-artifacts.json"))).toBe(true);
  });

  it("recovers an unsigned owner root from its exact durable reservation", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
    const token = "reserved-unsigned-root-token";
    const ownerRoot = join(parent, `.trusty-squire-owner-${token}`);
    const artifact = join(ownerRoot, "session");
    const reservation = join(root, `.trusty-squire-artifact-reservation-${token}.json`);
    const manifestPath = join(root, "unsigned-root.json");
    cleanup.push(root, parent);
    await mkdir(ownerRoot, { mode: 0o700 });
    await writeFile(
      reservation,
      `${JSON.stringify({
        version: 1,
        token,
        path: artifact,
        root_path: ownerRoot,
        owner_token: "manifest",
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        version: 5,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [],
        helpers: [],
        artifacts: [
          {
            path: artifact,
            root_path: ownerRoot,
            token,
            state: "pending",
            reservation_path: reservation,
          },
        ],
      })}\n`,
    );

    await sweepOrphanedOwnerProcesses(root);

    expect(existsSync(ownerRoot)).toBe(false);
    expect(existsSync(reservation)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "rolls back signed artifacts when manifest commit fails",
    async () => {
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
      cleanup.push(root, parent);
      const reaper = startOwnerProcessReaper({ rootDir: root });
      expect(reaper).not.toBeNull();

      expect(() =>
        trackOwnerSessionArtifact(join(parent, "session"), {
          commitArtifact: () => {
            throw new Error("injected manifest commit failure");
          },
        }),
      ).toThrow("injected manifest commit failure");

      expect(readdirSync(parent)).toEqual([]);
      const manifest = JSON.parse(readFileSync(reaper!.manifestPath, "utf8")) as {
        artifacts: unknown[];
      };
      expect(manifest.artifacts).toEqual([]);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "refuses pre-existing and symlink session artifact leaves",
    async () => {
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
      const existing = join(parent, "existing");
      const target = join(parent, "target");
      const linked = join(parent, "linked");
      cleanup.push(root, parent);
      await mkdir(existing, { mode: 0o700 });
      await mkdir(target, { mode: 0o700 });
      await symlink(target, linked);
      expect(startOwnerProcessReaper({ rootDir: root })).not.toBeNull();

      expect(() => trackOwnerSessionArtifact(existing)).toThrow(
        "session artifact path already exists",
      );
      expect(() => trackOwnerSessionArtifact(linked)).toThrow(
        "session artifact path already exists",
      );
      expect(existsSync(existing)).toBe(true);
      expect(existsSync(target)).toBe(true);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "revalidates exact artifact ownership before reuse and removal",
    async () => {
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "10");
      const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
      const parent = await mkdtemp(join(tmpdir(), "trusty-squire-observe-parent-"));
      const artifact = join(parent, "session");
      cleanup.push(root, parent);
      expect(startOwnerProcessReaper({ rootDir: root })).not.toBeNull();
      const ownedArtifact = trackOwnerSessionArtifact(artifact);
      await writeFile(
        join(ownedArtifact, OWNER_ARTIFACT_SIGNATURE_FILE),
        `${JSON.stringify({ version: 1, token: "lookalike", path: ownedArtifact })}\n`,
        { mode: 0o600 },
      );

      expect(() => trackOwnerSessionArtifact(artifact)).toThrow(
        "session artifact ownership changed",
      );
      expect(() => removeOwnerSessionArtifact(artifact)).toThrow(
        "session artifact ownership changed",
      );
      expect(existsSync(ownedArtifact)).toBe(true);
    },
  );
});
