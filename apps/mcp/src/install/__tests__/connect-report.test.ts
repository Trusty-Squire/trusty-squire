// Pure classifier for connect's machine-readable report. Every reachable
// state is a typed value; human sentences render from the same object.

import { describe, expect, it } from "vitest";
import {
  alreadyConnectedMessage,
  buildConnectReport,
  connectIncompleteMessage,
  decideConnectComplete,
  observeConnectBrowserLocation,
  type ConnectHolder,
  type ConnectReportInput,
} from "../connect-report.js";

const noneHolder: ConnectHolder = { kind: "none" };
const otherHolder: ConnectHolder = {
  kind: "other",
  code: "singleton_lock",
  pid: 4242,
  host: "box",
};
const noBrowser = { kind: "none" as const };

function classify(partial: Omit<ConnectReportInput, "holder" | "browser_location"> & {
  holder?: ConnectHolder;
  browser_location?: ConnectReportInput["browser_location"];
}) {
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
      reason: "already_provisioned",
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
    expect(afterCeremony.reason).toBe("ceremony_complete");
    expect(afterCeremony.account).toEqual({ id: "acc_1", providers: ["google"] });
    expect(afterCeremony.sign_in_url).toBeNull();
  });

  it("never reports connected from an unverified machine claim", () => {
    const report = classify({
      outcome: { kind: "unverified", account_id: "acc_1" },
      holder: otherHolder,
    });
    expect(report.state).toBe("busy");
    expect(report.reason).toBe("unverified_probe");
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
    expect(report.reason).toBe("probe_failed");
    expect(report.account).toBeNull();
  });

  it("puts the sign-in URL in its own field, never mixed with other links", () => {
    const url = "https://trustysquire.ai/install?token=setup_only";
    const report = classify({
      outcome: { kind: "ceremony_waiting", confirm_url: url, skip_browser: false },
      browser_location: { kind: "host_screen", display: ":1" },
    });
    expect(report.state).toBe("needs-sign-in");
    expect(report.reason).toBe("ceremony_required");
    expect(report.sign_in_url).toBe(url);
    expect(JSON.stringify(report).match(/https:\/\//g)).toHaveLength(1);
  });

  it("names skip-browser sign-in as needs-sign-in with no Squire browser", () => {
    const url = "https://trustysquire.ai/install?token=skip";
    const report = classify({
      outcome: { kind: "ceremony_waiting", confirm_url: url, skip_browser: true },
    });
    expect(report.state).toBe("needs-sign-in");
    expect(report.reason).toBe("skip_browser");
    expect(report.sign_in_url).toBe(url);
    expect(report.browser_location).toEqual({ kind: "none" });
  });

  it("reports busy with a holder code, not a sentence", () => {
    const report = classify({
      outcome: { kind: "profile_busy" },
      holder: otherHolder,
    });
    expect(report.state).toBe("busy");
    expect(report.reason).toBe("profile_busy");
    expect(report.holder).toEqual(otherHolder);
    expect(JSON.stringify(report.holder)).not.toMatch(/already using the browser/i);
  });

  it("names an unknown holder when busy but nothing readable holds the profile", () => {
    const report = classify({ outcome: { kind: "profile_busy" } });
    expect(report.holder).toEqual({ kind: "unknown", reason: "identity_unknown" });
  });

  it("reports no-browser when Squire cannot show the ceremony", () => {
    const report = classify({
      outcome: { kind: "display_unshowable", detail: "no discoverable display" },
      browser_location: { kind: "unreachable", reason: "no discoverable display" },
    });
    expect(report.state).toBe("no-browser");
    expect(report.reason).toBe("display_unshowable");
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
    expect(report.reason).toBe("no_google_session");
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

  it("always emits the five fields", () => {
    const reports = [
      classify({
        outcome: { kind: "provisioned", account_id: "a", providers: ["google"] },
      }),
      classify({
        outcome: {
          kind: "ceremony_waiting",
          confirm_url: "https://example.test/in",
          skip_browser: false,
        },
      }),
      classify({ outcome: { kind: "profile_busy" }, holder: otherHolder }),
      classify({
        outcome: { kind: "display_unshowable", detail: "gone" },
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

describe("observeConnectBrowserLocation", () => {
  it("uses the host screen when one is live, virtual only when it is not", () => {
    expect(
      observeConnectBrowserLocation({
        phase: "decided",
        host_screen_live: true,
        display: ":1",
      }),
    ).toEqual({ kind: "host_screen", display: ":1" });
    expect(
      observeConnectBrowserLocation({
        phase: "decided",
        host_screen_live: false,
      }),
    ).toEqual({ kind: "virtual" });
  });

  it("reports none when Squire launched no browser", () => {
    expect(observeConnectBrowserLocation({ phase: "none" })).toEqual({ kind: "none" });
    expect(observeConnectBrowserLocation({ phase: "skip_browser" })).toEqual({ kind: "none" });
  });

  it("says unknown with a reason when the display cannot be determined", () => {
    expect(observeConnectBrowserLocation({ phase: "decided" })).toEqual({
      kind: "unknown",
      reason: "display_probe_unavailable",
    });
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
