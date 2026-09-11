// Regression tests for the Clerk bot-protection scope defect measured live on
// accounts.cartesia.ai/sign-in/protect-check (RC.13/RC.14 native testing,
// 2026-09-11): Clerk fronts the sign-in with its own Turnstile wrapper and
// posts the verification result from per-client RANDOM subdomains of
// client.protect.clerk.com (e.g. 1-8fd91a2f-p.client.protect.clerk.com) plus
// specter.protect.clerk.com. With only the service host in scope those posts
// were aborted (host_not_allowed, remedy restart_session) and the widget could
// NEVER complete — "Verification didn't complete" — no matter how it was
// clicked. The challenge result hosts are part of the sign-in the caller
// already authorized, so the request-scope guard must let them through, and a
// challenge blocker must carry the denied challenge hosts as cause: scope
// instead of leaving the host agent to correlate scope_denials itself.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import {
  BrowserController,
  clerkChallengeScopeForDocument,
  requestHostInScope,
} from "../browser.js";
import { annotateChallengeBlockersWithScope } from "../provision-session.js";
import type { HostScopeDenialDiagnostic } from "../browser.js";
import type { SafeBlockerV2 } from "../compact-observation-v2.js";

// A Clerk-hosted protect-check document: the service's account portal loads
// Clerk's widget (#clerk-captcha) which posts the verification result to the
// per-client protect hosts while the checkbox is being solved.
const PROTECT_CHECK_HTML = `<!doctype html>
<html>
<head><title>Protecting your account</title></head>
<body>
  <main>Verifying you are human</main>
  <div id="clerk-captcha" data-clerk-captcha></div>
  <script src="https://clerk.service.test/npm/@clerk/clerk-js.js"></script>
  <script>
    window.__protectPosts = Promise.allSettled([
      fetch("https://1-8fd91a2f-p.client.protect.clerk.com/v1/website/verify", { method: "POST" }),
      fetch("https://specter.protect.clerk.com/v1/client/preflight", { method: "POST" }),
      fetch("https://clerk.service.test/v1/client", { method: "POST" })
    ]).then((results) => results.map((r) => r.status).join(","));
  </script>
</body>
</html>`;

let browser: Browser | undefined;
afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

interface Harness {
  context: BrowserContext;
  controller: BrowserController;
  page: Page;
}

// Serves the Clerk protect-check document on the session's service host and a
// 200 JSON answer on every protect host, exactly as the real endpoints would.
async function clerkProtectCheckFixture(): Promise<Harness> {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("https://accounts.service.test/")) {
      await route.fulfill({
        contentType: "text/html",
        body: PROTECT_CHECK_HTML,
      });
      return;
    }
    if (
      url.endsWith(".client.protect.clerk.com") ||
      url.endsWith(".protect.clerk.com") ||
      url.startsWith("https://clerk.service.test/")
    ) {
      await route.fulfill({
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "{}",
      });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: "<main>service</main>" });
  });
  const controller = BrowserController.fromHarnessPage(await context.newPage());
  await controller.enableBrokerRouting();
  const session = await BrowserController.attachSessionPage(controller, { humanize: false });
  await session.setHostScopeAllowedHosts(() => ["accounts.service.test"]);
  await session.goto("https://accounts.service.test/sign-in/protect-check");
  const page = (session as unknown as { page: Page }).page;
  return { context, controller: session, page };
}

describe("Clerk bot-protection hosts are part of the authorized sign-in scope", () => {
  it("lets the protect-check document post its verification result to the per-client protect hosts", async () => {
    const { controller, page } = await clerkProtectCheckFixture();
    // The widget's result posts resolve — the challenge CAN complete.
    expect(await page.evaluate("window.__protectPosts.then(String)")).toBe(
      "fulfilled,fulfilled,fulfilled",
    );
    expect(controller.takeHostScopeDenials()).toEqual([]);
  });

  it("still blocks genuinely out-of-scope hosts from the same document", async () => {
    const { controller, page } = await clerkProtectCheckFixture();
    expect(
      await page.evaluate(
        "fetch('https://tracker.other.test/api').then(() => 'escaped', () => 'blocked')",
      ),
    ).toBe("blocked");
    const denials = controller.takeHostScopeDenials();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      hostname: "tracker.other.test",
      reason: "host_not_allowed",
    });
  });

  it("extends only a Clerk-backed accounts document, including its Frontend API host", () => {
    const allowedHosts = clerkChallengeScopeForDocument(
      "https://accounts.service.test/sign-in",
      true,
    );
    expect(
      requestHostInScope(
        "https://1-8fd91a2f-p.client.protect.clerk.com/v1/website/verify",
        allowedHosts,
      ),
    ).toBe(true);
    expect(
      requestHostInScope("https://specter.protect.clerk.com/v1/client/preflight", allowedHosts),
    ).toBe(true);
    expect(requestHostInScope("https://clerk.service.test/v1/client", allowedHosts)).toBe(true);
    expect(requestHostInScope("https://tracker.other.test/api", allowedHosts)).toBe(false);
    expect(clerkChallengeScopeForDocument("https://accounts.service.test/sign-in", false)).toEqual(
      [],
    );
    expect(clerkChallengeScopeForDocument("https://app.service.test/sign-in", true)).toEqual([]);
  });

  it("honors caller-declared wildcard extra_allowed_hosts without widening to the base host", () => {
    const allowedHosts = ["*.client.protect.clerk.com"];
    expect(
      requestHostInScope(
        "https://1-8fd91a2f-p.client.protect.clerk.com/v1/website/verify",
        allowedHosts,
      ),
    ).toBe(true);
    expect(
      requestHostInScope("https://client.protect.clerk.com/v1/website/verify", allowedHosts),
    ).toBe(false);
  });
});

describe("annotateChallengeBlockersWithScope", () => {
  const clerkDenial = (hostname: string): HostScopeDenialDiagnostic => ({
    hostname,
    resource_type: "fetch",
    reason: "host_not_allowed",
    count: 3,
    first_seen_at: 1,
    last_seen_at: 2,
    owner: { document_id: "d", frame: "main", hostname: "accounts.service.test" },
    remedy: { action: "restart_session", tool: "operate_start", allowed_host: hostname },
  });

  const challengeBlocker = (text: string): SafeBlockerV2 => ({ kind: "challenge", text });

  it("surfaces denied challenge hosts on the challenge blocker as cause: scope", () => {
    const result = {
      stage: "auth",
      semantic: {
        blocked: true as const,
        blockers: [challengeBlocker("Verification didn't complete. Try again.")],
      },
    };
    const annotated = annotateChallengeBlockersWithScope(result, [
      clerkDenial("1-8fd91a2f-p.client.protect.clerk.com"),
      clerkDenial("specter.protect.clerk.com"),
    ]);
    expect(annotated.semantic.blockers).toEqual([
      {
        kind: "challenge",
        text: "Verification didn't complete. Try again.",
        cause: "scope",
        cause_hosts: ["1-8fd91a2f-p.client.protect.clerk.com", "specter.protect.clerk.com"],
      },
    ]);
  });

  it("does not annotate validation blockers or non-challenge denials", () => {
    const result = {
      stage: "form",
      semantic: {
        blocked: true as const,
        blockers: [{ kind: "validation" as const, text: "Email is required" }],
      },
    };
    const annotated = annotateChallengeBlockersWithScope(result, [
      clerkDenial("api.internal.metrics.test"),
    ]);
    expect(annotated).toEqual(result);
    expect(annotated).toBe(result);
  });

  it("leaves the result untouched when no challenge blocker is present", () => {
    const result = { stage: "auth", semantic: { blocked: true as const, blockers: [] } };
    expect(
      annotateChallengeBlockersWithScope(result, [clerkDenial("specter.protect.clerk.com")]),
    ).toBe(result);
  });
});
