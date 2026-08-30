import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OWNER_PROFILE_SIGNATURE_FILE,
  sweepOrphanedOwnerProcesses,
} from "../owner-process-reaper.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    cleanup.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })),
  );
});

describe("owner process startup sweep", () => {
  it("removes only an exactly signed Trusty Squire ephemeral profile", async () => {
    vi.stubEnv("TRUSTY_SQUIRE_REAPER_TERM_GRACE_MS", "1");
    const root = await mkdtemp(join(tmpdir(), "trusty-squire-reaper-test-"));
    const signed = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    const foreign = await mkdtemp(join(tmpdir(), "trusty-squire-operate-"));
    cleanup.push(root, signed, foreign);
    const token = "signed-profile-token";
    await writeFile(
      join(signed, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token, path: signed })}\n`,
    );
    await writeFile(
      join(foreign, OWNER_PROFILE_SIGNATURE_FILE),
      `${JSON.stringify({ version: 1, token: "someone-else", path: foreign })}\n`,
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "stale.json"),
      `${JSON.stringify({
        version: 2,
        token: "manifest",
        owner: { pid: 999_999_999, start_time: "1" },
        resources: [],
        launches: [],
        profiles: [
          { path: signed, token },
          { path: foreign, token },
        ],
      })}\n`,
    );

    await sweepOrphanedOwnerProcesses(root);

    expect(existsSync(signed)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(await readFile(join(foreign, OWNER_PROFILE_SIGNATURE_FILE), "utf8")).toContain(
      "someone-else",
    );
  });
});
