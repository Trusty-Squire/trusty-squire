// Regression: a control the drive observed and decided on must be dispatched by
// the shared executor, resolved by the identity it was observed under.
//
// Before the shared-executor consolidation the drive resolved its own refs
// in-page; after it, an `oauth_login` step fell back to the tools path and threw
// `stale_ref` before any click, so the page never changed and the drive gave up
// within seconds. This test drives the real `dispatchDriveAct` boundary against a
// fixture whose external sign-in control navigates the SAME TAB to an invented
// identity provider and back, and asserts the hand-off actually lands. It fails
// on the pre-fix head (`dispatchDriveAct` returns `unsupported`) and passes once
// the drive path dispatches its own control.
//
// The fixture is deliberately provider-agnostic: an invented provider host and a
// generic control label, so it cannot pass merely because the product happens to
// special-case one real provider. The `provider` is left undefined; the drive's
// own identity resolution is what is under test.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { BrowserController } from "../browser.js";
import {
  captureFrameSnapshot,
  driveRowsFromSnapshot,
  type DriveSnapshot,
} from "../drive-snapshot.js";
import { dispatchDriveAct } from "../act/act.js";
import { rememberDriveIdentities } from "../act/identity.js";
import { emptyDriveState, runOperateDrive } from "../operate-drive.js";
import { sessionForCall } from "../session/lifecycle.js";
import { act, finishProvisionSession, startHarnessProvisionSession } from "../provision-session.js";

const PRODUCT = "https://app.handoff-fixture.test";
const PROVIDER = "https://idp.provider-fixture.test";
const CONTROL_LABEL = "Continue with your organization";

type CompactRow = [string, string, string?];

async function driveSnapshotFor(page: Page): Promise<DriveSnapshot> {
  const snapshot = await captureFrameSnapshot(page, [], 0);
  if (snapshot === null) throw new Error("no drive snapshot");
  return snapshot;
}

function driveRefForLabel(snapshot: DriveSnapshot, label: string): string | undefined {
  const rows = driveRowsFromSnapshot(snapshot) as unknown as CompactRow[];
  return rows.find(([, , facts]) => {
    const value = facts ?? "";
    return value.split("|")[0] === label || value.includes(label);
  })?.[0];
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
});

async function openHandoffFixture(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const html = (body: string) => route.fulfill({ contentType: "text/html; charset=utf-8", body });
    if (url.hostname === "idp.provider-fixture.test") {
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const sep = redirectUri.includes("?") ? "&" : "?";
      return html(`<!doctype html><meta charset=utf-8><title>Identity provider</title>
<main><h1>Sign in</h1><p>operator@example.com</p></main>
<script>
setTimeout(function(){ location.replace(${JSON.stringify(redirectUri)} + ${JSON.stringify(sep)} + "code=fixture_code&state=s1"); }, 60);
</script>`);
    }
    if (url.hostname === "app.handoff-fixture.test") {
      if (url.pathname === "/auth/callback") {
        return html(`<!doctype html><meta charset=utf-8><title>Callback</title>
<main><h1>Completing sign-in…</h1>
<script>setTimeout(function(){ location.replace("/dashboard"); }, 60);</script></main>`);
      }
      if (url.pathname === "/dashboard") {
        return html(`<!doctype html><meta charset=utf-8><title>Dashboard</title>
<main><h1>Dashboard</h1><p>Signed in as operator@example.com</p></main>`);
      }
      const providerUrl = new URL(`${PROVIDER}/authorize`);
      providerUrl.searchParams.set("redirect_uri", `${PRODUCT}/auth/callback`);
      return html(`<!doctype html><meta charset=utf-8><title>Sign in</title>
<main><h1>Sign in</h1>
<button id="handoff" type="button">${CONTROL_LABEL}</button>
<script>
document.getElementById("handoff").addEventListener("click", function(){
  window.location.href = ${JSON.stringify(providerUrl.href)};
});
</script>
</main>`);
    }
    return html("<main>unexpected</main>");
  });
  await page.goto(`${PRODUCT}/signin`, { waitUntil: "domcontentloaded" });
  return { page, close: () => context.close() };
}

describe("drive hand-off dispatch by observed identity", () => {
  it("accepts the public drive handle for atomic OAuth without translation", async () => {
    const { page, close } = await openHandoffFixture();
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: `${PRODUCT}/signin`,
      format: "compact",
      initialObservation: "drive",
    });
    try {
      await runOperateDrive(
        { session_id: started.session_id, goal: "inspect sign-in", max_steps: 0 },
        null,
      );
      const anchor = [...sessionForCall(started.session_id)!.compactV2DriveAnchors].find(
        ([, candidate]) => candidate.identity.label === CONTROL_LABEL,
      );
      expect(anchor?.[0]).toMatch(/^@e:/);
      await act(started.session_id, { kind: "oauth_login", target: anchor![0] });
      expect(page.url()).toContain("/dashboard");
    } finally {
      await finishProvisionSession(started.session_id).catch(() => undefined);
      await close();
    }
  }, 120_000);

  it("dispatches a drive-observed external sign-in control and follows the same-tab navigation", async () => {
    const { page, close } = await openHandoffFixture();
    const started = await startHarnessProvisionSession({
      browser: BrowserController.fromHarnessPage(page),
      serviceUrl: `${PRODUCT}/signin`,
      format: "compact",
      initialObservation: "drive",
    });
    const navigations: string[] = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations.push(frame.url());
    });
    try {
      const snapshot = await driveSnapshotFor(page);
      const ref = driveRefForLabel(snapshot, CONTROL_LABEL);
      expect(ref).toBeDefined();

      // The drive's own snapshot recorded the control's identity; dispatchDriveAct
      // must resolve it by that record.
      const session = sessionForCall(started.session_id);
      expect(session).toBeDefined();
      session!.drive ??= emptyDriveState("fixture", {});
      rememberDriveIdentities(session!.drive, snapshot.elements, snapshot.url);

      // The drive decides an external sign-in hand-off. The shared executor must
      // dispatch it by the drive's own identity record, not by the tools' index.
      const result = await dispatchDriveAct(started.session_id, {
        kind: "oauth_login",
        target: ref!,
      });
      expect(result.kind).toBe("ok");

      // ...and the control actually left the product origin and came back
      // through the product's callback.
      expect(navigations.some((url) => url.startsWith(PROVIDER))).toBe(true);
      expect(navigations.some((url) => url.includes("/auth/callback"))).toBe(true);
      expect(page.url()).not.toContain("/signin");
    } finally {
      await finishProvisionSession(started.session_id).catch(() => undefined);
      await close();
    }
  }, 120_000);
});
