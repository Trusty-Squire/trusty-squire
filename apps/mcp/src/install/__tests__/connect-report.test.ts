// Pure classifier for connect's machine-readable report. Every reachable
// state is a typed value; human sentences render from the same object.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdtempSync, openSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireProfileOperationGuard, type ProfileOperationLease } from "../../bot/profile.js";
import {
  alreadyConnectedMessage,
  beginConnectRun,
  buildConnectReport,
  connectIncompleteMessage,
  decideConnectComplete,
  emitConnectReport,
  snapshotConnectHolder,
  type ConnectHolder,
  type ConnectReportInput,
} from "../connect-report.js";

const noneHolder: ConnectHolder = { kind: "none" };
const otherHolder: ConnectHolder = { kind: "other", code: "singleton_lock", pid: 4242 };
const noBrowser = { kind: "none" as const };

function classify(
  partial: Omit<ConnectReportInput, "holder" | "browser_location"> & {
    holder?: ConnectHolder;
    browser_location?: ConnectReportInput["browser_location"];
  },
) {
  return buildConnectReport({
    holder: partial.holder ?? noneHolder,
    browser_location: partial.browser_location ?? noBrowser,
    outcome: partial.outcome,
  });
}

describe("buildConnectReport", () => {
  // The no-ceremony fast path opens nothing — it reads the profile's cookie
  // store — so its `connected` must not pass for a probed one. The human copy
  // on that branch already warns those cookies can outlive the real session.
  it("marks a connected answer read off the cookie store as exactly that", () => {
    const provisioned = classify({
      outcome: { kind: "provisioned", account_id: "acc_1", providers: ["google", "github"] },
    });
    expect(provisioned).toEqual({
      state: "connected",
      reason: "cached_cookie_evidence",
      sign_in_url: null,
      account: { id: "acc_1", providers: ["google", "github"] },
      holder: noneHolder,
      browser_location: noBrowser,
    });

    const afterCeremony = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: ["google"],
      },
    });
    expect(afterCeremony.state).toBe("connected");
    expect(afterCeremony.reason).toBeNull();
    expect(afterCeremony.account).toEqual({ id: "acc_1", providers: ["google"] });
    expect(afterCeremony.sign_in_url).toBeNull();
  });

  it("never reports connected from an unverified machine claim", () => {
    const report = classify({
      outcome: { kind: "unverified", account_id: null },
      holder: otherHolder,
    });
    expect(report.state).toBe("busy");
    expect(report.reason).toBe("profile_unverifiable");
    expect(report.account).toBeNull();
    expect(report.sign_in_url).toBeNull();
  });

  it("fails closed when the post-ceremony probe itself failed", () => {
    expect(decideConnectComplete(null)).toEqual({ ok: false, reason: "probe_failed" });
    const report = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: null,
      },
      holder: otherHolder,
    });
    expect(report.state).toBe("busy");
    expect(report.reason).toBe("profile_unverifiable");
    expect(report.account).toBeNull();
  });

  it("puts the still-live sign-in URL in its own field, never mixed with other links", () => {
    const url = "https://trustysquire.ai/install?token=setup_only";
    const report = classify({
      outcome: { kind: "install_unclaimed", confirm_url: url },
      browser_location: { kind: "host_screen", display: ":1" },
    });
    expect(report.state).toBe("needs-sign-in");
    expect(report.reason).toBeNull();
    expect(report.sign_in_url).toBe(url);
    expect(JSON.stringify(report).match(/https:\/\//g)).toHaveLength(1);
  });

  it("keeps the sign-in URL when the skip-browser wait ran out", () => {
    const url = "https://trustysquire.ai/install?token=skip";
    const report = classify({ outcome: { kind: "install_unclaimed", confirm_url: url } });
    expect(report.state).toBe("needs-sign-in");
    expect(report.sign_in_url).toBe(url);
    expect(report.browser_location).toEqual({ kind: "none" });
  });

  // A browser that opened on the user's screen and was then closed is not
  // "no browser": the pairing token is still pending, so the run still holds
  // the one URL that finishes the job.
  it("calls a closed-or-abandoned ceremony a sign-in, not a missing browser", () => {
    const url = "https://trustysquire.ai/install?token=closed";
    const report = classify({
      outcome: { kind: "install_unclaimed", confirm_url: url },
      browser_location: { kind: "host_screen", display: ":0" },
    });
    expect(report.state).toBe("needs-sign-in");
    expect(report.sign_in_url).toBe(url);
    expect(report.browser_location).toEqual({ kind: "host_screen", display: ":0" });
  });

  it("calls a ceremony nothing could show a missing browser, URL still in hand", () => {
    const url = "https://trustysquire.ai/install?token=unreachable";
    const report = classify({
      outcome: { kind: "install_unclaimed", confirm_url: url },
      browser_location: { kind: "unreachable", reason: "no discoverable display" },
    });
    expect(report.state).toBe("no-browser");
    expect(report.sign_in_url).toBe(url);
  });

  // The central promise: a caller never meets needs-sign-in with nowhere to go.
  it("never reports needs-sign-in without the URL, for any outcome", () => {
    const outcomes: ConnectReportInput["outcome"][] = [
      { kind: "provisioned", account_id: "a", providers: ["google"] },
      { kind: "unverified", account_id: null },
      { kind: "ceremony_complete", account_id: "a", providers: null },
      { kind: "ceremony_complete", account_id: "a", providers: [] },
      {
        kind: "ceremony_complete",
        account_id: "a",
        providers: ["google"],
        requested_provider: "github",
      },
      { kind: "profile_busy" },
      { kind: "install_unclaimed", confirm_url: "https://example.test/in" },
      { kind: "install_expired" },
      { kind: "account_switch_refused" },
      { kind: "cookie_clear_failed" },
      { kind: "run_failed" },
    ];
    for (const outcome of outcomes) {
      for (const browser_location of [
        noBrowser,
        { kind: "host_screen" as const, display: ":0" },
        { kind: "unreachable" as const, reason: "nothing to show it on" },
      ]) {
        const report = classify({ outcome, browser_location });
        if (report.state === "needs-sign-in") {
          expect(typeof report.sign_in_url, `${outcome.kind}/${browser_location.kind}`).toBe(
            "string",
          );
        }
      }
    }
  });

  it("reports busy with a holder code, not a sentence", () => {
    const report = classify({ outcome: { kind: "profile_busy" }, holder: otherHolder });
    expect(report.state).toBe("busy");
    expect(report.reason).toBeNull();
    expect(report.holder).toEqual(otherHolder);
    expect(JSON.stringify(report.holder)).not.toMatch(/already using the browser/i);
  });

  // The holder is reported as READ. A profile Squire could not verify is not
  // evidence that something holds it, and telling a caller to wait for a
  // profile nothing holds is the wait that never ends.
  it("reports the holder it observed, never a guess, on every busy outcome", () => {
    for (const outcome of [
      { kind: "profile_busy" },
      { kind: "unverified", account_id: null },
      { kind: "cookie_clear_failed" },
    ] as const) {
      expect(classify({ outcome }).holder, outcome.kind).toEqual({ kind: "none" });
      expect(classify({ outcome, holder: otherHolder }).holder, outcome.kind).toEqual(otherHolder);
    }
  });

  // A lapsed pairing token has no live URL, so it is never a needs-sign-in
  // and never puts a dead URL in sign_in_url.
  it("reports an expired install as its own reason, with no URL", () => {
    const report = classify({
      outcome: { kind: "install_expired" },
      browser_location: { kind: "host_screen", display: ":0" },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("install_expired");
    expect(report.sign_in_url).toBeNull();
  });

  it("reports a run that failed before it could settle as no-browser", () => {
    const report = classify({ outcome: { kind: "run_failed" } });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("run_failed");
    expect(report.sign_in_url).toBeNull();
    expect(report.browser_location).toEqual({ kind: "none" });
  });

  it("maps skip-browser leftover with no Google session to no-browser", () => {
    const report = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: [],
      },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("provider_session_missing");
    // The run bound this machine to that account before the probe answered —
    // reporting no account would deny a binding connect had just written.
    // The empty provider list is what the probe actually saw.
    expect(report.account).toEqual({ id: "acc_1", providers: [] });
  });

  // The preflight could not read the profile, but the stored session names the
  // account this machine is bound to. Intent item 3 asks which account is
  // connected when one is; that is knowable here without claiming a session.
  it("keeps the bound account on an unverifiable preflight", () => {
    const report = classify({ outcome: { kind: "unverified", account_id: "acc_1" } });
    expect(report.state).toBe("busy");
    expect(report.reason).toBe("profile_unverifiable");
    expect(report.account).toEqual({ id: "acc_1", providers: [] });
  });

  // This gate makes the run print a failure and exit 1. Answering `connected`
  // on the machine channel told a caller the opposite of the exit code, and a
  // caller that asked for GitHub precisely because it needs GitHub believed it.
  it("does not say connected when the scoped provider refresh missed", () => {
    const report = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: ["google"],
        requested_provider: "github",
      },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("requested_provider_missing");
    expect(report.sign_in_url).toBeNull();
    // The ceremony landed Google and the session was written: this run knows
    // exactly which account the machine is bound to, so it says so.
    expect(report.account).toEqual({ id: "acc_1", providers: ["google"] });
  });

  it("names a refused account switch as its own reason", () => {
    const report = classify({
      outcome: { kind: "account_switch_refused" },
      browser_location: { kind: "host_screen", display: ":0" },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("account_mismatch");
    expect(report.sign_in_url).toBeNull();
  });

  it("always emits the same six fields", () => {
    const reports = [
      classify({ outcome: { kind: "provisioned", account_id: "a", providers: ["google"] } }),
      classify({
        outcome: { kind: "install_unclaimed", confirm_url: "https://example.test/in" },
      }),
      classify({ outcome: { kind: "profile_busy" }, holder: otherHolder }),
      classify({ outcome: { kind: "run_failed" } }),
    ];
    for (const report of reports) {
      expect(Object.keys(report).sort()).toEqual(
        ["account", "browser_location", "holder", "reason", "sign_in_url", "state"].sort(),
      );
    }
  });
});

describe("human copy renders from the same facts", () => {
  it("keeps the already-connected sentence", () => {
    expect(alreadyConnectedMessage(["google", "github"], "Cursor")).toBe(
      "Already connected (google + github). Cursor config refreshed.",
    );
  });

  it("keeps the incomplete-reason sentences", () => {
    expect(connectIncompleteMessage("no_google_session", true)).toContain("--skip-browser");
    expect(connectIncompleteMessage("probe_failed", false)).toContain("won't call this connected");
  });
});

// Chrome's SingletonLock is a symlink named `<host>-<pid>`; a crashed or
// killed browser leaves one behind pointing at a pid that is gone. That is
// what `reapLeakedProfileHolder` clears — so it is not a holder.
describe("snapshotConnectHolder", () => {
  function lockedProfile(pid: number): string {
    const dir = mkdtempSync(join(tmpdir(), "ts-connect-holder-"));
    symlinkSync(`${hostname()}-${pid}`, join(dir, "SingletonLock"));
    return dir;
  }

  it("reports no holder for a lock whose process is gone", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeGreaterThan(0);
    expect(snapshotConnectHolder(lockedProfile(dead!))).toEqual({ kind: "none" });
  });

  it("reports no holder when the profile carries no lock at all", () => {
    expect(snapshotConnectHolder(mkdtempSync(join(tmpdir(), "ts-connect-holder-")))).toEqual({
      kind: "none",
    });
  });
});

// The report is best-effort output. A caller that closed the pipe it was
// reading (EPIPE), or a full non-blocking one (EAGAIN), must not turn a
// finished run into a crash or replace the run's real error with a write
// error — `writeSync` throws where the stream write it replaced did not.
describe("emitConnectReport", () => {
  it("does not throw when the machine channel is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ts-connect-emit-"));
    const closed = openSync(join(dir, "sink"), "w");
    closeSync(closed);
    const original = process.stdout.fd;
    Object.defineProperty(process.stdout, "fd", {
      value: closed,
      configurable: true,
      writable: true,
    });
    beginConnectRun();
    try {
      expect(() =>
        emitConnectReport(
          buildConnectReport({
            outcome: { kind: "run_failed" },
            holder: { kind: "none" },
            browser_location: { kind: "none" },
          }),
          true,
        ),
      ).not.toThrow();
    } finally {
      Object.defineProperty(process.stdout, "fd", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

// The noVNC tunnel and the browser it showed both die with the ceremony, and
// the report is emitted after that — so any address named here would resolve
// to nothing. Naming the display without an address is the honest answer; the
// live one is on stderr while the run is still going.
describe("a virtual placement", () => {
  it("names the display without handing back an address", () => {
    const report = classify({
      outcome: { kind: "install_expired" },
      browser_location: { kind: "virtual" },
    });
    expect(report.browser_location).toEqual({ kind: "virtual" });
  });
});

// The profile-OPERATION lease is a second holder, and the one a refused run
// actually collided with: `--force-relogin` takes it and deletes the profile
// directory — SingletonLock with it — so reading only Chrome's lock answered
// "nobody holds it" on exactly the run that was turned away.
describe("snapshotConnectHolder reads the operation lease too", () => {
  let child: ChildProcess | undefined;
  let lease: ProfileOperationLease | undefined;

  afterEach(() => {
    lease?.release();
    lease = undefined;
    child?.kill("SIGKILL");
    child = undefined;
  });

  // The lease records the acquiring process. Taking it while `process.pid`
  // reads as a live foreign process is how a test gets a lease owned by
  // someone else without a second TypeScript runtime.
  function leaseHeldBy(profileDir: string, pid: number): ProfileOperationLease {
    const own = Object.getOwnPropertyDescriptor(process, "pid");
    Object.defineProperty(process, "pid", { value: pid, configurable: true });
    try {
      return acquireProfileOperationGuard(profileDir);
    } finally {
      if (own !== undefined) Object.defineProperty(process, "pid", own);
    }
  }

  it("names the session that holds the lease when no browser lock exists", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-connect-lease-"));
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child?.once("spawn", () => resolve()));
    lease = leaseHeldBy(profileDir, child.pid!);

    expect(snapshotConnectHolder(profileDir)).toEqual({
      kind: "other",
      code: "operation_lease",
      pid: child.pid,
    });
  });

  it("does not name a lease whose process is gone", () => {
    const profileDir = mkdtempSync(join(tmpdir(), "ts-connect-lease-"));
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeGreaterThan(0);
    lease = leaseHeldBy(profileDir, dead!);

    expect(snapshotConnectHolder(profileDir)).toEqual({ kind: "none" });
  });
});
