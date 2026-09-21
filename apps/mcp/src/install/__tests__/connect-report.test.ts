// Pure classifier for connect's machine-readable report. Every reachable
// state is a typed value; human sentences render from the same object.

import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alreadyConnectedMessage,
  buildConnectReport,
  connectIncompleteMessage,
  decideConnectComplete,
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
  it("reports connected only after a live Google session is proven", () => {
    const provisioned = classify({
      outcome: { kind: "provisioned", account_id: "acc_1", providers: ["google", "github"] },
    });
    expect(provisioned).toEqual({
      state: "connected",
      reason: null,
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
        skip_browser: false,
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
        skip_browser: false,
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

  it("reports busy with a holder code, not a sentence", () => {
    const report = classify({ outcome: { kind: "profile_busy" }, holder: otherHolder });
    expect(report.state).toBe("busy");
    expect(report.reason).toBeNull();
    expect(report.holder).toEqual(otherHolder);
    expect(JSON.stringify(report.holder)).not.toMatch(/already using the browser/i);
  });

  it("never says busy and nobody-holds-it in the same object", () => {
    for (const outcome of [
      { kind: "profile_busy" },
      { kind: "unverified" },
      { kind: "cookie_clear_failed" },
    ] as const) {
      expect(classify({ outcome }).holder, outcome.kind).toEqual({
        kind: "unknown",
        reason: "identity_unknown",
      });
    }
  });

  it("reports no-browser when Squire could not open the ceremony", () => {
    const report = classify({
      outcome: { kind: "browser_confirm_failed" },
      browser_location: { kind: "unreachable", reason: "no discoverable display" },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBeNull();
    expect(report.browser_location).toEqual({
      kind: "unreachable",
      reason: "no discoverable display",
    });
  });

  it("maps skip-browser leftover with no Google session to no-browser", () => {
    const report = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: [],
        skip_browser: true,
      },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("provider_session_missing");
    expect(report.account).toBeNull();
  });

  it("maps a missing scoped provider to needs-sign-in", () => {
    const report = classify({
      outcome: {
        kind: "ceremony_complete",
        account_id: "acc_1",
        providers: ["google"],
        requested_provider: "github",
        skip_browser: false,
      },
    });
    expect(report.state).toBe("needs-sign-in");
    expect(report.reason).toBe("requested_provider_missing");
    expect(report.account).toBeNull();
  });

  it("names a refused account switch as its own reason", () => {
    const report = classify({ outcome: { kind: "account_switch_refused" } });
    expect(report.state).toBe("needs-sign-in");
    expect(report.reason).toBe("account_mismatch");
  });

  it("always emits the same six fields", () => {
    const reports = [
      classify({ outcome: { kind: "provisioned", account_id: "a", providers: ["google"] } }),
      classify({
        outcome: { kind: "install_unclaimed", confirm_url: "https://example.test/in" },
      }),
      classify({ outcome: { kind: "profile_busy" }, holder: otherHolder }),
      classify({
        outcome: { kind: "browser_confirm_failed" },
        browser_location: { kind: "unreachable", reason: "gone" },
      }),
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

  it("reports a live lock held by this process as self", () => {
    expect(snapshotConnectHolder(lockedProfile(process.pid))).toEqual({
      kind: "self",
      code: "this_process",
      pid: process.pid,
    });
  });

  it("reports no holder when the profile carries no lock at all", () => {
    expect(snapshotConnectHolder(mkdtempSync(join(tmpdir(), "ts-connect-holder-")))).toEqual({
      kind: "none",
    });
  });
});
