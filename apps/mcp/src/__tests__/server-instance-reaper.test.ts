// Reconnects were leaving the superseded `mcp server` behind: a live box
// carried a superseded claude-code server beside its replacement plus two
// codex-identity servers orphaned to init for ~31 hours, each keeping a
// browser/reaper child tree resident.
//
// The reap that fixes it runs on a box shared by every lane/home, where
// several LIVE servers of the same agent identity (one per project) are
// normal. So these tests are mostly about what must NOT be killed: a
// different identity, ourselves, anything still serving a client, and
// anything whose process state we cannot actually read.

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listLiveServerInstances,
  processDescendantIdentities,
  reapStaleServerInstances,
  registerServerInstance,
  readServerInstanceRecord,
  serverInstanceReapDecision,
  type ParentPidRead,
  type ServerInstanceRecord,
  type ServerReapBounds,
} from "../server-instance-registry.js";

const BOUNDS: ServerReapBounds = {
  orphanGraceMs: 60_000,
  idleMs: 20 * 60_000,
  idleWithSessionMs: 12 * 60 * 60_000,
  idleSlackMs: 5 * 60_000,
  graceMs: 5,
};

const SELF = { agent_identity: "claude-code", pid: 900, start_time: "900" };
const NOW = 10_000_000;

function record(overrides: Partial<ServerInstanceRecord> = {}): ServerInstanceRecord {
  return {
    version: 1,
    agent_identity: "claude-code",
    pid: 100,
    start_time: "100",
    parent_pid: 50,
    started_at: NOW - 60 * 60_000,
    heartbeat_at: NOW,
    last_activity_at: NOW,
    active_sessions: 0,
    in_flight_calls: 0,
    server_version: "1.1.13",
    ...overrides,
  };
}

const decide = (
  entry: ServerInstanceRecord,
  parentPid: ParentPidRead,
  self = SELF,
  liveness: "matching" | "stale" | "unknown" = "matching",
) => serverInstanceReapDecision(entry, self, liveness, parentPid, NOW, BOUNDS);

describe("serverInstanceReapDecision", () => {
  it("never touches a different agent identity, however orphaned and stale", () => {
    const other = record({ agent_identity: "codex", last_activity_at: NOW - 31 * 60 * 60_000 });
    expect(decide(other, 1)).toBe("keep");
  });

  it("never targets an identity-less launch, so an unset identity matches nothing", () => {
    const anonymous = { agent_identity: "", pid: 900, start_time: "900" };
    expect(decide(record({ agent_identity: "" }), 1, anonymous)).toBe("keep");
  });

  it("never targets ourselves", () => {
    expect(decide(record({ pid: SELF.pid, start_time: SELF.start_time }), 1)).toBe("keep");
  });

  it("never targets our pid even under a stale recorded start time", () => {
    expect(decide(record({ pid: SELF.pid, start_time: "stale" }), 1)).toBe("keep");
  });

  it("keeps a same-identity instance with recent client activity", () => {
    expect(decide(record({ last_activity_at: NOW - 1_000 }), 50)).toBe("keep");
  });

  it("keeps a quiet same-identity instance that is still doing work", () => {
    const busy = record({ last_activity_at: NOW - 60 * 60_000, active_sessions: 1 });
    expect(decide(busy, 50)).toBe("keep");
    expect(decide(record({ last_activity_at: NOW - 60 * 60_000, in_flight_calls: 1 }), 50)).toBe(
      "keep",
    );
  });

  it("reaps a quiet, idle same-identity instance past its own idle bound", () => {
    // Its own idle timer polls every 5m, so it is only demonstrably failing to
    // exit once it is past 20m + one poll interval.
    expect(decide(record({ last_activity_at: NOW - 21 * 60_000 }), 50)).toBe("keep");
    expect(decide(record({ last_activity_at: NOW - 26 * 60_000 }), 50)).toBe("reap");
  });

  it("reaps a busy instance only once it blows the (much longer) session bound", () => {
    const abandoned = record({ last_activity_at: NOW - 13 * 60 * 60_000, active_sessions: 1 });
    expect(decide(abandoned, 50)).toBe("reap");
  });

  it("reaps an orphan past the short grace, and keeps one inside it", () => {
    expect(decide(record({ last_activity_at: NOW - 5 * 60_000 }), 1)).toBe("reap");
    expect(decide(record({ last_activity_at: NOW - 1_000 }), 1)).toBe("keep");
  });

  it("does not read a host that was already init as an orphan", () => {
    const containerChild = record({ parent_pid: 1, last_activity_at: NOW - 5 * 60_000 });
    expect(decide(containerChild, 1)).toBe("keep");
  });

  it("forgets the record of a process that is already gone", () => {
    expect(decide(record(), 50, SELF, "stale")).toBe("forget");
    expect(decide(record(), "stale")).toBe("forget");
  });

  it("forgets a dead record of another identity too — file GC signals nothing", () => {
    expect(decide(record({ agent_identity: "codex" }), 50, SELF, "stale")).toBe("forget");
  });

  it("keeps anything whose process state it cannot read", () => {
    expect(decide(record({ last_activity_at: 0 }), 50, SELF, "unknown")).toBe("keep");
    expect(decide(record({ last_activity_at: 0 }), "unknown")).toBe("keep");
  });
});

describe("processDescendantIdentities", () => {
  const parents = new Map<number, number>([
    [11, 10],
    [12, 11],
    [13, 12],
    [20, 1],
  ]);

  it("walks the PPid chain to the whole tree without including the root", () => {
    const found = processDescendantIdentities(10, {
      readProcessIds: () => [10, 11, 12, 13, 20],
      readParentPid: (pid) => parents.get(pid) ?? "stale",
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
    });
    expect(found.map((entry) => entry.pid).sort()).toEqual([11, 12, 13]);
  });

  it("terminates on a parent cycle instead of spinning", () => {
    const found = processDescendantIdentities(30, {
      readProcessIds: () => [30, 31, 32],
      readParentPid: (pid) => (pid === 31 ? 30 : pid === 32 ? 31 : 32),
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
    });
    expect(found.map((entry) => entry.pid).sort()).toEqual([31, 32]);
  });
});

describe("reapStaleServerInstances", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function rootWith(records: ServerInstanceRecord[]): string {
    const root = mkdtempSync(join(tmpdir(), "ts-server-instances-"));
    roots.push(root);
    for (const entry of records) {
      writeFileSync(join(root, `${entry.pid}-${entry.start_time}.json`), JSON.stringify(entry));
    }
    return root;
  }

  it("terminates an orphaned prior instance and its whole child tree", async () => {
    // pid 100 is the wedged server; 101 its Chrome, 102 a Chrome renderer,
    // 103 the owner-process-reaper worker it left behind.
    const alive = new Set([100, 101, 102, 103]);
    const tree = new Map<number, number>([
      [101, 100],
      [102, 101],
      [103, 100],
    ]);
    const killed: Array<[number, NodeJS.Signals]> = [];
    const root = rootWith([record({ last_activity_at: NOW - 5 * 60_000 })]);
    const sweep = vi.fn(async () => 0);

    const summary = await reapStaleServerInstances({
      rootDir: root,
      self: SELF,
      bounds: BOUNDS,
      now: () => NOW,
      readBirthState: (identity) => (alive.has(identity.pid) ? "matching" : "stale"),
      readParentPid: (pid) => (pid === 100 ? 1 : (tree.get(pid) ?? "stale")),
      readDescendants: (pid) =>
        processDescendantIdentities(pid, {
          readProcessIds: () => [...tree.keys()],
          readParentPid: (candidate) => tree.get(candidate) ?? "stale",
          readBirthIdentity: (candidate) => ({ pid: candidate, start_time: String(candidate) }),
        }),
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        // Everything but the wedged server itself honours SIGTERM.
        if (pid !== 100) alive.delete(pid);
      },
      wait: async () => undefined,
      sweep,
    });

    expect(summary.reaped).toBe(1);
    expect(
      killed
        .filter(([, signal]) => signal === "SIGTERM")
        .map(([pid]) => pid)
        .sort(),
    ).toEqual([100, 101, 102, 103]);
    // Grace first, SIGKILL only for what survived it.
    expect(killed.filter(([, signal]) => signal === "SIGKILL")).toEqual([[100, "SIGKILL"]]);
    expect(killed.every(([pid]) => [100, 101, 102, 103].includes(pid))).toBe(true);
    // The dead owner's reaper manifest is swept so a re-parented browser the
    // PPid walk already missed still goes.
    expect(sweep).toHaveBeenCalledOnce();
  });

  it("leaves a live same-identity server and a live different-identity server alone", async () => {
    const killed: number[] = [];
    const root = rootWith([
      record({ pid: 200, start_time: "200", last_activity_at: NOW - 1_000 }),
      record({
        pid: 300,
        start_time: "300",
        agent_identity: "codex",
        last_activity_at: NOW - 31 * 60 * 60_000,
      }),
    ]);

    const summary = await reapStaleServerInstances({
      rootDir: root,
      self: SELF,
      bounds: BOUNDS,
      now: () => NOW,
      readBirthState: () => "matching",
      // Both look orphaned; identity and live traffic are what actually gate.
      readParentPid: () => 1,
      readDescendants: () => [],
      kill: (pid) => killed.push(pid),
      wait: async () => undefined,
      sweep: async () => 0,
    });

    expect(summary).toMatchObject({ reaped: 0, kept: 2, forgotten: 0 });
    expect(killed).toEqual([]);
    expect(readdirSync(root)).toHaveLength(2);
  });

  it("drops the record of a dead prior instance without signalling anything", async () => {
    const killed: number[] = [];
    const root = rootWith([record({ last_activity_at: NOW - 5 * 60_000 })]);

    const summary = await reapStaleServerInstances({
      rootDir: root,
      self: SELF,
      bounds: BOUNDS,
      now: () => NOW,
      readBirthState: () => "stale",
      readParentPid: () => 1,
      readDescendants: () => [],
      kill: (pid) => killed.push(pid),
      wait: async () => undefined,
      sweep: async () => 0,
    });

    expect(summary).toMatchObject({ reaped: 0, forgotten: 1 });
    expect(killed).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("does nothing at all when this launch has no agent identity", async () => {
    const killed: number[] = [];
    const root = rootWith([record({ last_activity_at: NOW - 31 * 60 * 60_000 })]);

    const summary = await reapStaleServerInstances({
      rootDir: root,
      self: { agent_identity: "", pid: 900, start_time: "900" },
      bounds: BOUNDS,
      now: () => NOW,
      readBirthState: () => "matching",
      readParentPid: () => 1,
      readDescendants: () => [],
      kill: (pid) => killed.push(pid),
      wait: async () => undefined,
      sweep: async () => 0,
    });

    expect(summary).toMatchObject({ reaped: 0, forgotten: 0 });
    expect(killed).toEqual([]);
    expect(readdirSync(root)).toHaveLength(1);
  });
});

describe("registerServerInstance", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== "linux")(
    "publishes activity a later launch can judge, and clears it on release",
    () => {
      const root = mkdtempSync(join(tmpdir(), "ts-server-instances-"));
      roots.push(root);
      const handle = registerServerInstance({ rootDir: root, identity: "claude-code" });
      expect(handle).not.toBeNull();
      expect(readServerInstanceRecord(handle!.path)).toMatchObject({
        agent_identity: "claude-code",
        pid: process.pid,
        active_sessions: 0,
      });

      handle!.heartbeat({ lastActivityAt: 4_242, activeSessions: 2, inFlightCalls: 1 });
      expect(readServerInstanceRecord(handle!.path)).toMatchObject({
        last_activity_at: 4_242,
        active_sessions: 2,
        in_flight_calls: 1,
      });

      handle!.release();
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("stays out of the registry entirely when no agent identity is set", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-server-instances-"));
    roots.push(root);
    expect(registerServerInstance({ rootDir: root, identity: "" })).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });
});

// Several servers legitimately run side by side, each serving the build it
// launched with and the account it was launched for. The inventory is how they
// are told apart — it reports, it never signals.
describe("live instance inventory (read-only)", () => {
  it("lists only records whose process is still alive, newest first", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-server-instances-"));
    try {
      const live = record({ pid: 101, start_time: "101", started_at: 1_000 });
      const newer = record({ pid: 102, start_time: "102", started_at: 2_000 });
      const dead = record({ pid: 103, start_time: "103", started_at: 3_000 });
      for (const entry of [live, newer, dead]) {
        writeFileSync(join(root, `${entry.pid}.json`), JSON.stringify(entry));
      }
      const listed = listLiveServerInstances({
        rootDir: root,
        readBirthState: (identity) => (identity.pid === 103 ? "stale" : "matching"),
      });
      expect(listed.map((entry) => entry.pid)).toEqual([102, 101]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing when the instance directory does not exist", () => {
    expect(listLiveServerInstances({ rootDir: join(tmpdir(), "ts-no-such-dir-abc123") })).toEqual(
      [],
    );
  });

  it("carries the build and bound account that tell two live servers apart", () => {
    const root = mkdtempSync(join(tmpdir(), "ts-server-instances-"));
    try {
      const handle = registerServerInstance({
        rootDir: root,
        identity: "claude-code",
        accountId: "01KS0BKRYTVE9T9FAQQ31A4MK3",
      });
      // Non-Linux boxes publish no record at all; nothing to assert there.
      if (handle === null) return;
      expect(readServerInstanceRecord(handle.path)).toMatchObject({
        server_version: expect.any(String),
        account_id: "01KS0BKRYTVE9T9FAQQ31A4MK3",
      });
      handle.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
