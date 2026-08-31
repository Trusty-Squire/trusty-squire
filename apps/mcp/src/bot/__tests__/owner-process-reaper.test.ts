import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_HELPER_MARKER_ENV,
  ownerBrowserLaunchState,
  ownerHelperIdentityState,
  shouldReapOwner,
  startOwnerProcessReaper,
  stopOwnerProcessReaper,
  sweepOrphanedOwnerProcesses,
  terminateOwnerBrowserLaunch,
  trackOwnerBrowserLaunch,
} from "../owner-process-reaper.js";
import { profileProcessIdentityState } from "../profile.js";

const testRequire = createRequire(import.meta.url);
const cleanupDirs: string[] = [];
const cleanupProcesses = new Set<number>();

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

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
  cleanupDirs.push(path);
  return path;
}

async function waitForGone(pid: number, timeout = 3_000): Promise<void> {
  await vi.waitFor(() => expect(processIsGone(pid)).toBe(true), { timeout });
  cleanupProcesses.delete(pid);
}

afterEach(async () => {
  stopOwnerProcessReaper();
  vi.unstubAllEnvs();
  for (const pid of cleanupProcesses) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  cleanupProcesses.clear();
  await Promise.all(
    cleanupDirs.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("owner process reaper contracts", () => {
  it("reaps only a definitely stale owner", () => {
    expect(shouldReapOwner("stale")).toBe(true);
    expect(shouldReapOwner("matching")).toBe(false);
    expect(shouldReapOwner("unknown")).toBe(false);
  });

  it("retains a browser marker when command, marker, or profile identity is untrusted", async () => {
    expect(
      ownerBrowserLaunchState("v1:browser", "/expected-profile", {
        readProcessIds: () => [101],
        readCommandState: () => "unknown",
        readMarkerState: () => ({ state: "present", marker: "v1:browser" }),
        readProfileState: () => "matching",
        readUidState: () => "matching",
      }),
    ).toBe("unknown");
    expect(
      ownerBrowserLaunchState("v1:browser", "/expected-profile", {
        readProcessIds: () => [101],
        readCommandState: () => "matching",
        readMarkerState: () => ({ state: "unknown" }),
        readProfileState: () => "matching",
        readUidState: () => "matching",
      }),
    ).toBe("unknown");
    const signals: Array<[number, NodeJS.Signals]> = [];
    await expect(
      terminateOwnerBrowserLaunch("v1:browser", "/expected-profile", {
        readProcessIds: () => [101],
        readCommandState: () => "matching",
        readMarkerState: () => ({ state: "present", marker: "v1:browser" }),
        readProfileState: () => "stale",
        kill: (pid, signal) => signals.push([pid, signal]),
        wait: async () => undefined,
      }),
    ).resolves.toBe(false);
    expect(signals).toEqual([]);
  });

  it("retains helper custody when its process group cannot be read", () => {
    expect(
      ownerHelperIdentityState(
        { pid: 101, start_time: "10", marker: "v1:helper", process_group_id: 101 },
        {
          readProcessIds: () => [101],
          readProcessGroupId: () => "unknown",
          readRunningState: () => "matching",
          readMarkerState: () => "unknown",
          readBirthState: () => "matching",
          readUidState: () => "matching",
        },
      ),
    ).toBe("unknown");
    expect(
      profileProcessIdentityState(
        {
          host: hostname(),
          pid: 101,
          start_time: "10",
          user_data_dir: "/expected-profile",
          process_group_id: "unknown",
          process_marker: "v1:browser",
        },
        "/expected-profile",
        {
          readBirthState: () => "stale",
          readGroupMarkerState: () => "unknown",
        },
      ),
    ).toBe("unknown");
  });

  it("rejects a reused helper PID by process birth identity", () => {
    expect(
      ownerHelperIdentityState(
        { pid: 101, start_time: "old", marker: "v1:helper" },
        {
          readRunningState: () => "matching",
          readBirthState: () => "stale",
          readMarkerState: () => "matching",
        },
      ),
    ).toBe("stale");
  });

  it.skipIf(process.platform !== "linux")(
    "fails closed when no ready worker can guard a Linux launch",
    async () => {
      const root = await tempDir();
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
        trackOwnerBrowserLaunch("v1:unguarded", join(root, "profile"), {
          ensureReaper: () => null,
        }),
      ).toThrow("owner process reaper unavailable for local browser launch");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "ignores legacy manifests, then startup-sweeps a current pending marker with TERM then KILL",
    async () => {
      const root = await tempDir();
      const marker = "v1:pending-helper";
      const descendantPath = join(root, "descendant.pid");
      const leaderPath = join(root, "leader.mjs");
      await writeFile(
        leaderPath,
        `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" });\nwriteFileSync(process.argv[2], String(child.pid));\nprocess.on("SIGTERM", () => undefined);\nsetInterval(() => undefined, 1000);\n`,
      );
      const leader = spawn(process.execPath, [leaderPath, descendantPath], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, [OWNER_HELPER_MARKER_ENV]: marker },
      });
      leader.unref();
      expect(leader.pid).toBeTypeOf("number");
      cleanupProcesses.add(leader.pid!);
      await vi.waitFor(() => expect(existsSync(descendantPath)).toBe(true));
      const descendantPid = Number(await readFile(descendantPath, "utf8"));
      cleanupProcesses.add(descendantPid);
      vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "20");
      const manifestPath = join(root, "stale.json");
      const manifest = {
        token: "manifest-token",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        helpers: [{ marker, state: "pending" }],
      };

      await writeFile(manifestPath, `${JSON.stringify({ version: 4, ...manifest })}\n`);
      await expect(sweepOrphanedOwnerProcesses(root)).resolves.toBe(0);
      expect(processIsGone(leader.pid!)).toBe(false);

      await writeFile(manifestPath, `${JSON.stringify({ version: 5, ...manifest })}\n`);
      await expect(sweepOrphanedOwnerProcesses(root)).resolves.toBeGreaterThan(0);
      await waitForGone(leader.pid!);
      await waitForGone(descendantPid);
      // The process group is gone, but an unreadable /proc entry may still make
      // the exact-marker scan unknown. Retaining the manifest is the safe side
      // of that uncertainty; a later worker pass can remove it once stale is proven.
      expect(existsSync(manifestPath)).toBe(true);
    },
    10_000,
  );

  it.skipIf(process.platform !== "linux")(
    "runs one ready worker and automatically replaces it after death",
    async () => {
      const root = await tempDir();
      const workerPath = join(root, "worker.mjs");
      await writeFile(
        workerPath,
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";\nconst countPath = new URL("./worker-count", import.meta.url);\nconst count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;\nwriteFileSync(countPath, String(count));\nwriteFileSync(new URL(\`./worker-\${count}.pid\`, import.meta.url), String(process.pid));\nwriteFileSync(process.argv[3], JSON.stringify({ version: 1, token: process.argv[4], pid: process.pid }) + "\\n");\nsetInterval(() => undefined, 1000);\n`,
      );
      let launchAttempt = 0;
      const reaper = startOwnerProcessReaper(
        { rootDir: root, workerPath },
        {
          beforeWorkerLaunch: () => {
            launchAttempt += 1;
            if (launchAttempt === 2) throw new Error("transient replacement failure");
          },
        },
      );
      expect(reaper).not.toBeNull();
      expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("1");
      const firstPid = Number(readFileSync(join(root, "worker-1.pid"), "utf8"));
      cleanupProcesses.add(firstPid);

      process.kill(firstPid, "SIGKILL");
      await waitForGone(firstPid);
      await vi.waitFor(() => expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("2"), {
        timeout: 5_000,
      });
      const secondPid = Number(readFileSync(join(root, "worker-2.pid"), "utf8"));
      cleanupProcesses.add(secondPid);
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
      expect(readFileSync(join(root, "worker-count"), "utf8")).toBe("2");
      expect(reaper!.isAvailable()).toBe(true);
      expect(launchAttempt).toBe(3);
    },
    10_000,
  );

  it.skipIf(process.platform !== "linux")(
    "leaves zero surviving tracked children after the owner is killed",
    async () => {
      const root = await tempDir();
      const ownerPath = join(root, "owner.ts");
      const readyPath = join(root, "ready.json");
      const errorPath = join(root, "error.txt");
      const moduleUrl = new URL("../owner-process-reaper.ts", import.meta.url).href;
      await writeFile(
        ownerPath,
        `import { writeFileSync } from "node:fs";\nvoid (async () => {\n  try {\n    const { spawnOwnerTrackedHelper, startOwnerProcessReaper } = await import(${JSON.stringify(moduleUrl)});\n    process.env.TRUSTY_SQUIRE_REAPER_POLL_MS = "10";\n    process.env.TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS = "20";\n    const reaper = startOwnerProcessReaper({ rootDir: ${JSON.stringify(root)} });\n    if (reaper === null) throw new Error("reaper unavailable");\n    const helper = spawnOwnerTrackedHelper(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" });\n    writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ owner: process.pid, helper: helper.pid }) + "\\n");\n    setInterval(() => undefined, 1000);\n  } catch (error) {\n    writeFileSync(${JSON.stringify(errorPath)}, error instanceof Error ? error.stack ?? error.message : String(error));\n    process.exit(1);\n  }\n})();\n`,
      );
      const owner = spawn(process.execPath, [testRequire.resolve("tsx/cli"), ownerPath], {
        detached: true,
        stdio: ["ignore", "ignore", "inherit"],
      });
      expect(owner.pid).toBeTypeOf("number");
      cleanupProcesses.add(owner.pid!);
      await vi.waitFor(() => expect(existsSync(readyPath) || existsSync(errorPath)).toBe(true), {
        timeout: 10_000,
      });
      if (existsSync(errorPath)) throw new Error(readFileSync(errorPath, "utf8"));
      const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
        owner: number;
        helper: number;
      };
      cleanupProcesses.add(ready.owner);
      cleanupProcesses.add(ready.helper);

      process.kill(ready.owner, "SIGKILL");
      await waitForGone(ready.owner);
      await waitForGone(ready.helper, 5_000);
      await vi.waitFor(
        () =>
          expect(
            existsSync(root) &&
              readFileSync(readyPath, "utf8").length > 0 &&
              processIsGone(ready.helper),
          ).toBe(true),
        { timeout: 1_000 },
      );
    },
    20_000,
  );
});
