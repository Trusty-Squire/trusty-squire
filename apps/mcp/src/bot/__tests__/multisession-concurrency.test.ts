// Step 4/5 of the multi-session browser broker migration (audit slice): the
// TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION flag. Two concerns, pinned here:
//
//   1. flag OFF is byte-identical to today: a second concurrent operate_start
//      still gets PROFILE_BUSY, and exactly one browser is ever constructed.
//   2. flag ON: a second (and Nth) operate_start joins the already-live
//      identity as a SATELLITE (its own BrowserController sharing the
//      primary's process), never trips PROFILE_BUSY, and the shared browser
//      survives whichever session finishes first — regardless of whether
//      that is the primary or a satellite. The real teardown always runs
//      exactly once, on whichever session's finish empties the group.
//
// Only ../browser.js is mocked (a fake BrowserController tracking
// construction/attachSatellite/start/close/closeOwnPagesOnly calls); the real
// profile-operation guard, IdentityRuntime, and session/lifecycle.ts run
// unmodified, so this exercises the actual admission and teardown logic.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as BrowserModule from "../browser.js";

interface FakeInstance {
  id: number;
  isSatellite: boolean;
  attachedToId: number | null;
  startCalls: number;
  closeCalls: number;
  closeOwnPagesOnlyCalls: number;
}

const h = vi.hoisted(() => ({
  providers: ["google"] as string[] | null,
  workerEmail: "operator@example.com" as string | null,
  nextId: 0,
  instances: [] as FakeInstance[],
  // Test levers: park the primary's real close, park a satellite attach, or
  // make a satellite's own-page close hang forever (a wedged Chrome).
  primaryCloseGate: null as Promise<void> | null,
  primaryOwnPagesGate: null as Promise<void> | null,
  attachGate: null as Promise<void> | null,
  attachEntered: null as (() => void) | null,
  hangOwnPagesClose: false,
}));

vi.mock("../browser.js", async (importOriginal) => {
  const actual = await importOriginal<typeof BrowserModule>();
  class FakeBrowserController {
    private readonly record: FakeInstance;
    constructor(_opts: unknown, sharedFrom?: FakeBrowserController) {
      this.record = {
        id: h.nextId++,
        isSatellite: sharedFrom !== undefined,
        attachedToId: sharedFrom?.record.id ?? null,
        startCalls: 0,
        closeCalls: 0,
        closeOwnPagesOnlyCalls: 0,
      };
      h.instances.push(this.record);
    }
    static async attachSatellite(
      primary: FakeBrowserController,
      opts: unknown = {},
    ): Promise<FakeBrowserController> {
      h.attachEntered?.();
      if (h.attachGate !== null) await h.attachGate;
      return new FakeBrowserController(opts, primary);
    }
    async start(): Promise<void> {
      this.record.startCalls += 1;
    }
    isConnected(): boolean {
      return true;
    }
    async close(): Promise<void> {
      this.record.closeCalls += 1;
      if (!this.record.isSatellite && h.primaryCloseGate !== null) await h.primaryCloseGate;
    }
    async closeOwnPagesOnly(): Promise<string> {
      this.record.closeOwnPagesOnlyCalls += 1;
      if (this.record.isSatellite && h.hangOwnPagesClose) await new Promise<never>(() => {});
      if (!this.record.isSatellite && h.primaryOwnPagesGate !== null) await h.primaryOwnPagesGate;
      return "closed";
    }
    async waitForThreeDsResolution(): Promise<string> {
      return "timeout";
    }
    async detectSessionProviders(): Promise<string[]> {
      return h.providers ?? [];
    }
    async detectGoogleAccountEmail(): Promise<string | null> {
      return h.workerEmail;
    }
    async setHostScopeAllowedHosts(): Promise<void> {}
    async goto(_url: string): Promise<void> {}
    currentUrl(): string {
      return "";
    }
    mainDocumentIdentity(): string {
      return "1";
    }
    recoverActivePage(): void {}
    armOpenedTabAdoption(): void {}
    async adoptOpenedTab(): Promise<string | null> {
      return null;
    }
    completeOAuthTransitionRecovery(): void {}
    async dismissConsentBanner(): Promise<string | null> {
      return null;
    }
    async waitForCaptchaChallengeToSettle(): Promise<boolean> {
      return false;
    }
    async extractInteractiveElements(): Promise<unknown[]> {
      return [];
    }
    async extractObservationSemantics(): Promise<{ title: string; headings: string[] }> {
      return { title: "", headings: [] };
    }
    async extractVisibleText(): Promise<string> {
      return "";
    }
    async extractCheckoutFieldNames(): Promise<string[]> {
      return [];
    }
    async readCheckoutSummary(): Promise<null> {
      return null;
    }
    async readCartLineItems(): Promise<unknown[]> {
      return [];
    }
  }
  return {
    ...actual,
    registerLocalBrowserLaunch: (
      _profileDir: string,
      baseEnv: NodeJS.ProcessEnv = process.env,
      marker = "v1:1:multisession-test",
    ) => ({
      marker,
      env: { ...baseEnv, TRUSTY_SQUIRE_OPERATOR_BROWSER_MARKER: marker },
    }),
    BrowserController: FakeBrowserController,
  };
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileBusyError } from "../profile.js";
import { startProvisionSession, finishProvisionSession, closeAllProvisionSessions } from "../provision-session.js";
import type { Session } from "../provision-session.js";
import { sessionForCall } from "../session/lifecycle.js";

let profileDir: string;

beforeEach(() => {
  h.providers = ["google"];
  h.workerEmail = "operator@example.com";
  h.nextId = 0;
  h.instances = [];
  h.primaryCloseGate = null;
  h.primaryOwnPagesGate = null;
  h.attachGate = null;
  h.attachEntered = null;
  h.hangOwnPagesClose = false;
  profileDir = mkdtempSync(join(tmpdir(), "ts-multisession-"));
});

afterEach(async () => {
  delete process.env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION;
  delete process.env.TRUSTY_SQUIRE_OPERATOR_FORCE_CLOSE_TIMEOUT_MS;
  await closeAllProvisionSessions().catch(() => undefined);
  rmSync(profileDir, { recursive: true, force: true });
});

describe("TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION off (default)", () => {
  it("admits exactly one session; a concurrent second operate_start gets PROFILE_BUSY", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    expect(h.instances).toHaveLength(1);

    await expect(
      startProvisionSession({ serviceUrl: "https://other.example.com", profileDir }),
    ).rejects.toBeInstanceOf(ProfileBusyError);
    // The busy attempt never constructed a second browser.
    expect(h.instances).toHaveLength(1);

    await finishProvisionSession(first.session_id);
    expect(h.instances[0]!.closeCalls).toBe(1);
    expect(h.instances[0]!.closeOwnPagesOnlyCalls).toBe(0);
  });
});

describe("TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION on", () => {
  beforeEach(() => {
    process.env.TRUSTY_SQUIRE_EXPERIMENTAL_MULTISESSION = "1";
  });

  it("joins a second session as a satellite of the already-live primary", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    const second = await startProvisionSession({
      serviceUrl: "https://other.example.com",
      profileDir,
    });

    expect(h.instances).toHaveLength(2);
    const [primaryRecord, satelliteRecord] = h.instances;
    expect(primaryRecord!.isSatellite).toBe(false);
    expect(satelliteRecord!.isSatellite).toBe(true);
    expect(satelliteRecord!.attachedToId).toBe(primaryRecord!.id);
    // The satellite never went through the primary's start() (no second
    // process launch) — attachSatellite is its own construction path.
    expect(satelliteRecord!.startCalls).toBe(0);
    expect(first.session_id).not.toBe(second.session_id);
  });

  it("survives the PRIMARY finishing first — the satellite stays operational and the real close runs only once, when the satellite finishes last", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    const second = await startProvisionSession({
      serviceUrl: "https://other.example.com",
      profileDir,
    });
    const [primaryRecord, satelliteRecord] = h.instances;

    await finishProvisionSession(first.session_id);
    // Primary finished while the satellite is still live: only its own page
    // closed, never the shared process.
    expect(primaryRecord!.closeOwnPagesOnlyCalls).toBe(1);
    expect(primaryRecord!.closeCalls).toBe(0);
    expect(satelliteRecord!.closeCalls).toBe(0);
    expect(satelliteRecord!.closeOwnPagesOnlyCalls).toBe(0);

    await finishProvisionSession(second.session_id);
    // Last one out: the real teardown runs on the PRIMARY even though the
    // SATELLITE is the one whose finish emptied the group.
    expect(primaryRecord!.closeCalls).toBe(1);
    expect(satelliteRecord!.closeOwnPagesOnlyCalls).toBe(1);
    expect(satelliteRecord!.closeCalls).toBe(0);
  });

  it("survives the SATELLITE finishing first — the primary stays operational and the real close runs once, when the primary finishes last", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    const second = await startProvisionSession({
      serviceUrl: "https://other.example.com",
      profileDir,
    });
    const [primaryRecord, satelliteRecord] = h.instances;

    await finishProvisionSession(second.session_id);
    expect(satelliteRecord!.closeOwnPagesOnlyCalls).toBe(1);
    expect(satelliteRecord!.closeCalls).toBe(0);
    expect(primaryRecord!.closeCalls).toBe(0);

    await finishProvisionSession(first.session_id);
    expect(primaryRecord!.closeCalls).toBe(1);
    // The primary itself is the last-out session, so it never needs its own
    // closeOwnPagesOnly — the real close() already tears its page down too.
    expect(primaryRecord!.closeOwnPagesOnlyCalls).toBe(0);
  });

  it("closes the shared Chrome exactly once when a forced shutdown preempts the last session's graceful finish", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    const second = await startProvisionSession({
      serviceUrl: "https://other.example.com",
      profileDir,
    });
    const [primaryRecord, satelliteRecord] = h.instances;
    await finishProvisionSession(first.session_id);
    expect(primaryRecord!.closeOwnPagesOnlyCalls).toBe(1);

    // Park the satellite's graceful finish INSIDE its terminal 3DS audit —
    // past its own forced check, before it releases the browser — by giving
    // it a pending 3DS outcome whose audit call only returns when told to.
    const session = sessionForCall(second.session_id);
    if (session === undefined) throw new Error("satellite session missing");
    let parked!: () => void;
    const audited = new Promise<void>((resolve) => (parked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    session.api = {
      auditPayment: async () => {
        parked();
        await released;
      },
    } as unknown as NonNullable<Session["api"]>;
    session.pendingThreeDs = {
      approval_id: "approval",
      approval_url: "https://trustysquire.ai/vault/approve/approval",
      checkout: {},
      last4: "4242",
      deadline: Date.now() + 60_000,
      outcome: "unknown",
    } as unknown as Session["pendingThreeDs"];

    const graceful = finishProvisionSession(second.session_id);
    await audited;
    // The transport disconnects: shutdown force-terminates the same session
    // while its graceful finish is still parked in the audit.
    const shutdown = closeAllProvisionSessions();
    while (session.terminalTeardownOwner?.forced !== true) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    release();
    await Promise.allSettled([graceful, shutdown]);

    // The group empties exactly once and the real close runs on the primary
    // — the shared Chrome is never orphaned by the race.
    expect(primaryRecord!.closeCalls).toBe(1);
    expect(satelliteRecord!.closeCalls).toBe(0);
    expect(satelliteRecord!.closeOwnPagesOnlyCalls).toBe(1);
  });

  it("refuses to join while the last session's teardown is already closing the shared Chrome", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    let releaseClose!: () => void;
    h.primaryCloseGate = new Promise<void>((resolve) => (releaseClose = resolve));
    const finishing = finishProvisionSession(first.session_id);
    while (h.instances[0]!.closeCalls === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    // The group is empty and its Chrome is mid-close: nothing to join.
    await expect(
      startProvisionSession({ serviceUrl: "https://other.example.com", profileDir }),
    ).rejects.toBeInstanceOf(ProfileBusyError);
    expect(h.instances).toHaveLength(1);

    releaseClose();
    await finishing;
    // With the group fully released, the next start is a fresh primary.
    const third = await startProvisionSession({
      serviceUrl: "https://third.example.com",
      profileDir,
    });
    expect(h.instances).toHaveLength(2);
    expect(h.instances[1]!.isSatellite).toBe(false);
    expect(h.instances[1]!.startCalls).toBe(1);
    await finishProvisionSession(third.session_id);
  });

  it("abandons a satellite whose group emptied while its attach was in flight", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    let releaseAttach!: () => void;
    h.attachGate = new Promise<void>((resolve) => (releaseAttach = resolve));
    const entered = new Promise<void>((resolve) => (h.attachEntered = resolve));
    const joining = startProvisionSession({ serviceUrl: "https://other.example.com", profileDir });
    await entered;

    // The only live session finishes completely while the attach is parked.
    await finishProvisionSession(first.session_id);
    expect(h.instances[0]!.closeCalls).toBe(1);

    releaseAttach();
    await expect(joining).rejects.toBeInstanceOf(ProfileBusyError);
    // The attached-but-unjoinable satellite closed its own page and was
    // never registered: a fresh start launches a new primary.
    expect(h.instances).toHaveLength(2);
    expect(h.instances[1]!.isSatellite).toBe(true);
    expect(h.instances[1]!.closeOwnPagesOnlyCalls).toBe(1);
    const third = await startProvisionSession({
      serviceUrl: "https://third.example.com",
      profileDir,
    });
    expect(h.instances).toHaveLength(3);
    expect(h.instances[2]!.isSatellite).toBe(false);
    await finishProvisionSession(third.session_id);
  });

  it("reports busy, not a runtime-internal error, when the second start's proxy differs from the live identity", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    await expect(
      startProvisionSession({
        serviceUrl: "https://other.example.com",
        profileDir,
        proxyUrl: "socks5://127.0.0.1:1080",
      }),
    ).rejects.toBeInstanceOf(ProfileBusyError);
    expect(h.instances).toHaveLength(1);
    await finishProvisionSession(first.session_id);
  });

  it("bounds a forced teardown even when a satellite's own-page close hangs", async () => {
    process.env.TRUSTY_SQUIRE_OPERATOR_FORCE_CLOSE_TIMEOUT_MS = "50";
    await startProvisionSession({ serviceUrl: "https://app.example.com", profileDir });
    await startProvisionSession({ serviceUrl: "https://other.example.com", profileDir });
    const [primaryRecord, satelliteRecord] = h.instances;
    h.hangOwnPagesClose = true;

    const outcome = await Promise.race([
      closeAllProvisionSessions().then(() => "closed" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
    ]);
    expect(outcome).toBe("closed");
    expect(satelliteRecord!.closeOwnPagesOnlyCalls).toBeGreaterThanOrEqual(1);
    expect(primaryRecord!.closeCalls).toBe(1);
  });

  it("keeps the profile guard held until the shared Chrome's close completes when two finishes overlap", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    const second = await startProvisionSession({
      serviceUrl: "https://other.example.com",
      profileDir,
    });
    const [primaryRecord] = h.instances;
    const tick = async (): Promise<void> =>
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

    // The primary finishes first but its own-page close is slow; the
    // satellite finishes meanwhile, empties the group, and is parked in the
    // shared Chrome's real close when the primary's teardown resumes.
    let releaseOwnPages!: () => void;
    h.primaryOwnPagesGate = new Promise<void>((resolve) => (releaseOwnPages = resolve));
    let releaseClose!: () => void;
    h.primaryCloseGate = new Promise<void>((resolve) => (releaseClose = resolve));
    const finishingPrimary = finishProvisionSession(first.session_id);
    while (primaryRecord!.closeOwnPagesOnlyCalls === 0) await tick();
    const finishingSatellite = finishProvisionSession(second.session_id);
    while (primaryRecord!.closeCalls === 0) await tick();
    releaseOwnPages();
    await tick();

    // The non-last session's teardown has completed, but the shared Chrome
    // is still closing: the profile guard must still be held, so a new start
    // is busy rather than launching a second Chrome against the profile.
    await expect(
      startProvisionSession({ serviceUrl: "https://third.example.com", profileDir }),
    ).rejects.toBeInstanceOf(ProfileBusyError);
    expect(h.instances).toHaveLength(2);

    releaseClose();
    await Promise.all([finishingPrimary, finishingSatellite]);
    const third = await startProvisionSession({
      serviceUrl: "https://third.example.com",
      profileDir,
    });
    expect(h.instances).toHaveLength(3);
    expect(h.instances[2]!.isSatellite).toBe(false);
    await finishProvisionSession(third.session_id);
  });

  it("joins a THIRD session while two are already live", async () => {
    const first = await startProvisionSession({
      serviceUrl: "https://app.example.com",
      profileDir,
    });
    await startProvisionSession({ serviceUrl: "https://b.example.com", profileDir });
    const third = await startProvisionSession({ serviceUrl: "https://c.example.com", profileDir });

    expect(h.instances).toHaveLength(3);
    expect(h.instances[2]!.isSatellite).toBe(true);
    expect(h.instances[2]!.attachedToId).toBe(h.instances[0]!.id);

    await finishProvisionSession(third.session_id);
    await finishProvisionSession(first.session_id);
  });
});
