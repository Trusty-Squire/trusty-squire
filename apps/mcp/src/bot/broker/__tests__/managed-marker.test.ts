import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  brokerUnitMarkerPath,
  readBrokerUnitMarkerAsync,
  readBrokerUnitMarkerSync,
  removeBrokerUnitMarker,
  writeBrokerUnitMarker,
} from "../managed-marker.js";
import { profileDeviceAnchor } from "../../profile.js";
import { brokerMayStartForMarker } from "../daemon.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshProfile(): string {
  const root = mkdtempSync(join(tmpdir(), "ts-managed-marker-"));
  roots.push(root);
  const profile = join(root, ".trusty-squire", "chrome-profile");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  return profile;
}

async function markerFor(profile: string, socket: string, accountBinding: string | null = null) {
  const anchor = profileDeviceAnchor(profile);
  if (anchor === null) throw new Error("profile has no device anchor");
  return { version: 1 as const, socket, profile: anchor, accountBinding };
}

describe("managed-broker marker contract", () => {
  it("sits next to the profile, not inside it, and survives a replaced profile directory", async () => {
    const profile = freshProfile();
    const socket = join(profile, "..", "broker.sock");
    await writeBrokerUnitMarker(profile, await markerFor(profile, socket));
    const path = brokerUnitMarkerPath(profile);
    expect(path.startsWith(join(profile, ".."))).toBe(true);
    expect(path.includes(join(profile, ".."))).toBe(true);
    // Replace the profile dir as --force-relogin would: the marker survives.
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    const read = await readBrokerUnitMarkerAsync(profile);
    expect(read.kind).toBe("valid");
  });

  it("round-trips a conforming marker write and read", async () => {
    const profile = freshProfile();
    const socket = join(profile, "..", "broker.sock");
    const marker = await markerFor(profile, socket, "beeline-account-1");
    await writeBrokerUnitMarker(profile, marker);
    const read = await readBrokerUnitMarkerAsync(profile);
    expect(read.kind).toBe("valid");
    if (read.kind === "valid") {
      expect(read.marker.socket).toBe(socket);
      expect(read.marker.accountBinding).toBe("beeline-account-1");
      expect(read.marker.profile).toEqual(marker.profile);
    }
  });

  it("removal restores the absent state", async () => {
    const profile = freshProfile();
    await writeBrokerUnitMarker(profile, await markerFor(profile, join(profile, "..", "broker.sock")));
    expect((await readBrokerUnitMarkerAsync(profile)).kind).toBe("valid");
    await removeBrokerUnitMarker(profile);
    expect((await readBrokerUnitMarkerAsync(profile)).kind).toBe("absent");
  });

  it("treats an unparsable or wrong-version marker as present-but-invalid, never absent", async () => {
    const profile = freshProfile();
    for (const content of ["{ not json", "{}", JSON.stringify({ version: 99, socket: "/x" })]) {
      writeFileSync(brokerUnitMarkerPath(profile), content, { mode: 0o600 });
      const read = await readBrokerUnitMarkerAsync(profile);
      expect(read.kind).toBe("invalid");
      expect(readBrokerUnitMarkerSync(profile).kind).toBe("invalid");
    }
  });
});

describe("broker daemon marker gate", () => {
  it("allows start without a marker regardless of unit env", () => {
    expect(brokerMayStartForMarker(false, {})).toBe(true);
    expect(brokerMayStartForMarker(false, { INVOCATION_ID: "abc" })).toBe(true);
  });

  it("refuses start with a marker unless the unit started it", () => {
    const brokerUnit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/trusty-squire-broker.service\n";
    const otherUnit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/beeline-agent@abc.service\n";
    expect(brokerMayStartForMarker(true, {}, brokerUnit)).toBe(false);
    // A broker unit's own process authorizes.
    expect(brokerMayStartForMarker(true, { INVOCATION_ID: "id" }, brokerUnit)).toBe(true);
    // INVOCATION_ID is inherited by every process of every unit (CI runners,
    // agent services): it does not authorize outside a broker unit.
    expect(brokerMayStartForMarker(true, { INVOCATION_ID: "id" }, otherUnit)).toBe(false);
    expect(brokerMayStartForMarker(true, { INVOCATION_ID: "id" }, "")).toBe(false);
    // The installer unit's explicit env flag authorizes too.
    expect(brokerMayStartForMarker(true, { TRUSTY_SQUIRE_BROKER_UNIT: "1" }, otherUnit)).toBe(true);
  });

  it("a foreign exec of the broker bin with a marker present exits non-zero with the refusal", async () => {
    const profile = freshProfile();
    await writeBrokerUnitMarker(profile, await markerFor(profile, join(profile, "..", "broker.sock")));
    const bin = fileURLToPath(new URL("../../../bin.ts", import.meta.url));
    const env: Record<string, string | undefined> = { ...process.env };
    env.HOME = join(profile, "..", "..");
    env.TRUSTY_SQUIRE_PROFILE_DIR = profile;
    // Deliberately scrubbed: INVOCATION_ID and TRUSTY_SQUIRE_BROKER_UNIT are
    // inherited when hoisting real unit env; a foreign exec has neither.
    delete env.INVOCATION_ID;
    delete env.TRUSTY_SQUIRE_BROKER_UNIT;
    const child = spawn(process.execPath, ["--import", "tsx", bin, "broker"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code).toBe(1);
    expect(stderr).toMatch(/refusing to start a foreign broker/);
    // The refusal happened before the profile lock, socket, or Chrome.
    expect((await readBrokerUnitMarkerAsync(profile)).kind).toBe("valid");
  });
});