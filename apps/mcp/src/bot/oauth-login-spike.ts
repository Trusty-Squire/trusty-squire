// OAuth-first feasibility spike — Phase 1, T1 (/plan-eng-review D1/D8).
//
// THE KILL-SWITCH QUESTION: can a Playwright-launched real-Chrome
// (channel:'chrome') persistent profile complete a Google login without
// Google's automation detection blocking it ("Couldn't sign you in —
// this browser or app may not be secure")?
//
// If this spike comes back BLOCKED, the OAuth-first F1 architecture (a
// bot-driven dedicated Chrome profile) does not work, and the plan must
// fall back to connectOverCDP into the user's own running browser. Run
// this BEFORE building anything else in Phase 1.
//
// SCOPE (D8 — deliberately narrow): tests the INITIAL login only.
// Session persistence across close/reopen and downstream re-consent are
// NOT tested here — the Phase 1 Render thin slice covers those.
//
// HEADLESS BOXES (D10): the login needs a visible window. On a
// display-less server, start a virtual display + noVNC first — see
// apps/mcp/OAUTH_SPIKE.md for the Xvfb + noVNC recipe — then run this
// with DISPLAY pointed at the virtual display.
//
// Run:  cd apps/mcp && npx tsx src/bot/oauth-login-spike.ts
//
// This is a manual dev harness — excluded from the published build via
// tsconfig.build.json, same as cli.ts / eval-planner.ts.

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright";

const require = createRequire(import.meta.url);

// Minimal shape of the chromium launcher the spike uses. The stealth
// toolchain (playwright-extra) ships CJS only, so it is require()'d and
// cast — the same lazy-load + cast pattern BrowserController uses.
interface PersistentLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContext>;
}

// Mirror BrowserController's stealth setup so the spike represents the
// real bot, not vanilla Playwright. Returns the launcher plus whether
// stealth actually loaded — the spike surfaces that, because a BLOCKED
// verdict means something different with stealth off.
function resolveChromium(): { chromium: PersistentLauncher; stealth: boolean } {
  try {
    const extra = require("playwright-extra") as {
      chromium: PersistentLauncher & { use: (plugin: unknown) => unknown };
    };
    const stealthPlugin = require("puppeteer-extra-plugin-stealth") as () => unknown;
    extra.chromium.use(stealthPlugin());
    return { chromium: extra.chromium, stealth: true };
  } catch (err) {
    console.error(`[spike] stealth plugin unavailable, vanilla chromium: ${String(err)}`);
    const vanilla = require("playwright") as { chromium: PersistentLauncher };
    return { chromium: vanilla.chromium, stealth: false };
  }
}

const PROFILE_DIR =
  process.env.OAUTH_SPIKE_PROFILE_DIR ?? join(homedir(), ".trusty-squire", "chrome-profile");

// Google auth cookies that are only set after a completed login.
const GOOGLE_AUTH_COOKIES = ["__Secure-1PSID", "SAPISID", "SID"];

// Copy Google shows when it blocks an automation-flagged browser.
const BLOCK_MARKERS = [
  "this browser or app may not be secure",
  "couldn't sign you in",
  "couldn’t sign you in",
];

async function main(): Promise<void> {
  const { chromium, stealth } = resolveChromium();
  console.error(`[spike] profile dir : ${PROFILE_DIR}`);
  console.error(`[spike] stealth     : ${stealth ? "active" : "UNAVAILABLE (vanilla chromium)"}`);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome", // the decision under test — real Chrome, not bundled
      headless: false, // the human must see the window to log in
      viewport: { width: 1280, height: 720 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
  } catch (err) {
    const msg = String(err);
    if (/Missing X server|DISPLAY|cannot open display/i.test(msg)) {
      console.error(
        "\n[spike] LAUNCH FAILED — no display. This box is headless.\n" +
          "        Start a virtual display + noVNC first — see apps/mcp/OAUTH_SPIKE.md\n",
      );
    } else if (/channel|Chromium distribution 'chrome'|Chrome.*not.*install/i.test(msg)) {
      console.error(
        "\n[spike] LAUNCH FAILED — Google Chrome (channel:'chrome') is not installed.\n" +
          "        Install it, or run: npx playwright install chrome\n",
      );
    } else {
      console.error(`\n[spike] LAUNCH FAILED: ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://accounts.google.com/", { waitUntil: "domcontentloaded" });

  console.error(
    "\n[spike] A Chrome window is open (view it via noVNC if this box is headless).\n" +
      "[spike] Log into your Google account in that window.\n" +
      "[spike] The spike auto-detects the result — up to 5 minutes.\n",
  );

  const deadline = Date.now() + 5 * 60 * 1000;
  let verdict: "pass" | "blocked" | "timeout" = "timeout";

  while (Date.now() < deadline) {
    const text = (await page.content().catch(() => "")).toLowerCase();
    if (BLOCK_MARKERS.some((m) => text.includes(m))) {
      verdict = "blocked";
      break;
    }
    const cookies = await context.cookies("https://www.google.com");
    if (cookies.some((c) => GOOGLE_AUTH_COOKIES.includes(c.name))) {
      verdict = "pass";
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const line = "=".repeat(64);
  console.error(`\n${line}`);
  if (verdict === "pass") {
    console.error(
      "[spike] PASS — Google login completed in a Playwright-launched\n" +
        "        channel:'chrome' persistent profile. The OAuth-first F1\n" +
        "        architecture is viable.\n" +
        `        Profile persisted at: ${PROFILE_DIR}\n` +
        "        Next: build the Phase 1 Render thin slice (close/reopen\n" +
        "        the profile + a real downstream OAuth signup).",
    );
  } else if (verdict === "blocked") {
    console.error(
      "[spike] BLOCKED — Google's automation detection rejected the login.\n" +
        "        The dedicated-profile F1 architecture does NOT work as-is.\n" +
        (stealth
          ? "        Stealth was active, so this is a hard block — fall back\n" +
            "        to connectOverCDP into the user's own running Chrome."
          : "        NOTE: stealth was UNAVAILABLE. Install playwright-extra +\n" +
            "        puppeteer-extra-plugin-stealth and re-run before concluding."),
    );
  } else {
    console.error(
      "[spike] TIMEOUT — no login completed in 5 min, no block page seen.\n" +
        "        Inconclusive. Re-run; if it recurs, treat as a soft fail.",
    );
  }
  console.error(`${line}\n`);

  await context.close();
  process.exitCode = verdict === "pass" ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`[spike] crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
