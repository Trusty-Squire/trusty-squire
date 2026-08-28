// Tests the BrowserController humanization toggle. We don't drive a
// real Chromium here — that's slow and flaky in CI — instead we verify
// the configuration plumbing and the fast-path behavior. The actual
// timing characteristics (bezier mouse, variable typing) are covered
// by end-to-end signup tests against real services.

import { describe, expect, it, vi } from "vitest";
import {
  BrowserController,
  captureOwnedChromeProcessTreeProof,
  claimOrphanBrowserReapScope,
  matchesReapableBrowserArgs,
  ownedChromeProcessTreeState,
  signalOwnedChromeProcessTree,
} from "../browser.js";
import { operatorBrowserMarkerStartedAt } from "../operator-browser-watchdog.js";
import { closeProfileWithProof } from "../profile.js";

describe("BrowserController humanize option", () => {
  it("defaults humanize to true", () => {
    // The default — match production where we want to pass anti-bot
    // scoring.
    const browser = new BrowserController();
    // humanize is private but we test the observable: instances
    // constructed with no opts should be considered humanized.
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(true);
  });

  it("respects explicit humanize: false", () => {
    // Tests should opt out so they don't wait 800-2000ms after every
    // goto() and 80-300ms before every click.
    const browser = new BrowserController({ humanize: false });
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(false);
  });

  it("respects explicit humanize: true", () => {
    const browser = new BrowserController({ humanize: true });
    expect((browser as unknown as { humanize: boolean }).humanize).toBe(true);
  });

  it("initializes a tracked mouse position so successive clicks form a path", () => {
    // The bezier-path mouse simulation needs a starting position. We
    // seed it at (100, 100) rather than (0, 0) because (0, 0) is the
    // exact corner of the viewport and a scorer could plausibly key
    // off "mouse starts at origin" as a tell.
    const browser = new BrowserController();
    expect((browser as unknown as { mouseX: number; mouseY: number }).mouseX).toBe(100);
    expect((browser as unknown as { mouseX: number; mouseY: number }).mouseY).toBe(100);
  });

  it("starts the operator process lifetime only when its marker is requested", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const browser = new BrowserController({ humanize: false });
      now.mockReturnValue(2_000);

      const marker = browser.operatorBrowserMarker();

      expect(operatorBrowserMarkerStartedAt(marker)).toBe(2_000);
      expect(browser.operatorBrowserMarker()).toBe(marker);
    } finally {
      now.mockRestore();
    }
  });
});

describe("orphan browser profile matching", () => {
  it("matches an exact configured profile with regex metacharacters", () => {
    const profileDir = "/tmp/operator+[team]/profile (primary)";
    expect(
      matchesReapableBrowserArgs(
        `google-chrome --user-data-dir=${profileDir} --remote-debugging-port=9222`,
        [profileDir],
        false,
      ),
    ).toBe(true);
    expect(
      matchesReapableBrowserArgs(
        "google-chrome --user-data-dir=/tmp/operatorXteam/profile primary",
        [profileDir],
        false,
      ),
    ).toBe(false);
  });

  it("continues to match verifier profiles", () => {
    expect(
      matchesReapableBrowserArgs(
        "chromium --user-data-dir=/home/test/.trusty-squire/profiles/verify-worker-1",
        [],
        true,
      ),
    ).toBe(true);
  });

  it("claims each operator profile once while claiming verifiers only once", () => {
    const first = claimOrphanBrowserReapScope("/tmp/operator-a");
    expect(first?.includeVerifier).toBe(true);
    expect(first?.profileDirs).toContain("/tmp/operator-a");

    expect(claimOrphanBrowserReapScope("/tmp/operator-a")).toBeNull();

    expect(claimOrphanBrowserReapScope("/tmp/operator-b")).toEqual({
      includeVerifier: false,
      profileDirs: ["/tmp/operator-b"],
    });
    expect(claimOrphanBrowserReapScope("/tmp/operator-b")).toBeNull();
  });
});

describe("self-managed Chrome process ownership", () => {
  const identity = {
    host: "test-host",
    pid: 4_242,
    start_time: "12345",
    user_data_dir: "/tmp/operator-profile",
  };

  it("signals the identity-proven detached process group, including renderers", () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    expect(
      signalOwnedChromeProcessTree(identity, true, "SIGKILL", {
        platform: "linux",
        profileMatches: () => true,
        memberState: () => "matching",
        processGroupId: () => 4_242,
        kill: (pid, signal) => killed.push({ pid, signal }),
      }),
    ).toBe(true);
    expect(killed).toEqual([{ pid: -4_242, signal: "SIGKILL" }]);
  });

  it("will not signal a PID whose profile identity has changed", () => {
    const kill = vi.fn();
    expect(
      signalOwnedChromeProcessTree(identity, true, "SIGKILL", {
        platform: "linux",
        profileMatches: () => false,
        kill,
      }),
    ).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("walks the profile-rooted tree for the non-detached headless fallback", () => {
    const killed: number[] = [];
    signalOwnedChromeProcessTree(identity, false, "SIGTERM", {
      platform: "linux",
      profileMatches: () => true,
      processTreePids: () => [4_242, 4_243, 4_244],
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
      memberState: () => "matching",
      kill: (pid) => killed.push(pid),
    });
    expect(killed).toEqual([4_244, 4_243, 4_242]);
  });

  it("keeps process-group ownership after the Chrome root exits", () => {
    const proof = captureOwnedChromeProcessTreeProof(identity, true, {
      platform: "linux",
      profileMatches: () => true,
      processTreePids: () => [4_242, 4_243],
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
    });
    if (proof === null) throw new Error("expected process-tree proof");
    const kill = vi.fn();

    expect(
      ownedChromeProcessTreeState(proof, {
        platform: "linux",
        profileMatches: () => false,
        memberState: (member) => (member.pid === 4_243 ? "matching" : "stale"),
      }),
    ).toBe("matching");
    expect(
      signalOwnedChromeProcessTree(identity, true, "SIGKILL", {
        platform: "linux",
        profileMatches: () => false,
        proof,
        memberState: (member) => (member.pid === 4_243 ? "matching" : "stale"),
        processGroupId: () => 4_242,
        kill,
      }),
    ).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4_242, "SIGKILL");
  });

  it("refuses a reused process group after every proven member exits", () => {
    const proof = captureOwnedChromeProcessTreeProof(identity, true, {
      platform: "linux",
      profileMatches: () => true,
      processTreePids: () => [4_242, 4_243],
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
    });
    if (proof === null) throw new Error("expected process-tree proof");
    const kill = vi.fn();

    expect(
      signalOwnedChromeProcessTree(identity, true, "SIGKILL", {
        platform: "linux",
        profileMatches: () => false,
        proof,
        memberState: () => "stale",
        processGroupId: () => 4_242,
        kill,
      }),
    ).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });

  it("does not report closed while an owned process-group member survives", async () => {
    const proof = captureOwnedChromeProcessTreeProof(identity, true, {
      platform: "linux",
      profileMatches: () => true,
    });
    if (proof === null) throw new Error("expected process-tree proof");
    let rootMatches = true;
    let groupExists = true;
    const killed: NodeJS.Signals[] = [];

    await expect(
      closeProfileWithProof({
        profileDir: identity.user_data_dir,
        identity,
        close: async () => {
          signalOwnedChromeProcessTree(identity, true, "SIGTERM", {
            platform: "linux",
            proof,
            memberState: () => "matching",
            processGroupId: () => 4_242,
            kill: (_pid, signal) => killed.push(signal),
          });
          rootMatches = false;
        },
        forceClose: () => {
          signalOwnedChromeProcessTree(identity, true, "SIGKILL", {
            platform: "linux",
            proof,
            memberState: () => "matching",
            processGroupId: () => 4_242,
            kill: (_pid, signal) => killed.push(signal),
          });
          groupExists = false;
        },
        identityState: () =>
          ownedChromeProcessTreeState(proof, {
            platform: "linux",
            profileMatches: () => rootMatches,
            memberState: () => (groupExists ? "matching" : "stale"),
          }),
        proofTimeoutMs: 1,
        pollMs: 1,
      }),
    ).resolves.toBe("force_closed_unproven");
    expect(killed).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("keeps fallback descendant ownership after the profile root exits", () => {
    const proof = captureOwnedChromeProcessTreeProof(identity, false, {
      platform: "linux",
      profileMatches: () => true,
      processTreePids: () => [4_242, 4_243, 4_244],
      readBirthIdentity: (pid) => ({ pid, start_time: String(pid) }),
    });
    if (proof === null) throw new Error("expected process-tree proof");
    const killed: number[] = [];

    expect(
      signalOwnedChromeProcessTree(identity, false, "SIGKILL", {
        platform: "linux",
        profileMatches: () => false,
        proof,
        memberState: (member) => (member.pid === 4_244 ? "matching" : "stale"),
        kill: (pid) => killed.push(pid),
      }),
    ).toBe(true);
    expect(killed).toEqual([4_244]);
  });
});
