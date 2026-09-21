// Pure classifier for connect's machine-readable report. Every reachable
// state is a typed value; human sentences render from the same object.

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
    const report = classify({ outcome: { kind: "unverified" }, holder: otherHolder });
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
      { kind: "unverified" },
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
      { kind: "unverified" },
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
    expect(report.account).toBeNull();
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
    expect(report.account).toBeNull();
    expect(report.sign_in_url).toBeNull();
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

// A display nobody is sitting at is only useful with the address that reaches
// it. Reporting the local X display name (`:99`) left a remote caller back
// where it started: scanning the terminal for the noVNC link.
describe("a virtual placement carries the surface that reaches it", () => {
  it("passes the exposure URL through to the report", () => {
    const report = classify({
      outcome: { kind: "install_expired" },
      browser_location: { kind: "virtual", url: "https://tunnel.invalid/#p=secret" },
    });
    expect(report.browser_location).toEqual({
      kind: "virtual",
      url: "https://tunnel.invalid/#p=secret",
    });
  });
});
