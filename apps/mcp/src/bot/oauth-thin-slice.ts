// oauth-thin-slice.ts — Phase 1, T12 (the payoff).
//
// A real, end-to-end OAuth signup on Render — the proof of the
// OAuth-first pivot. It reuses the Google session the feasibility
// spike (T1) left in the persistent Chrome profile; re-opening that
// profile from a fresh process is itself the D8 close/reopen test the
// deliberately-narrow spike did not cover.
//
// What it exercises end to end:
//   persistent-profile reuse → "Sign in with Google" click → the
//   consent scope gate → Render's (multi-stage) post-OAuth onboarding
//   → API-key extraction.
//
// Run:  cd apps/mcp && npx tsx src/bot/oauth-thin-slice.ts
//
// LLM: post-OAuth onboarding navigation needs a vision LLM. Provide one
// via OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or a working
// TRUSTY_SQUIRE_MACHINE_TOKEN. Without one the run still proves
// profile-reuse + the full OAuth handshake, then stops cleanly when the
// onboarding planner has no backend — the result reports how far it got.
//
// Manual dev harness — excluded from the published build via
// tsconfig.build.json, same as oauth-login-spike.ts.

import { createRequire } from "node:module";
import type { BrowserContext } from "playwright";
import {
  UniversalSignupBot,
  pickLLMPair,
  OpenRouterClient,
  type LLMClient,
  type LLMPair,
  type LLMRequest,
  type LLMResponse,
} from "./index.js";
import { BrowserController } from "./browser.js";
import { SignupAgent } from "./agent.js";
import { CHROME_PROFILE_DIR } from "./profile.js";

// Service + signup URL — overridable so the harness can be pointed at
// any previously-failed candidate, not just Render.
const SERVICE = process.env.T12_SERVICE ?? "Render";
const SIGNUP_URL =
  process.env.T12_SIGNUP_URL ?? "https://dashboard.render.com/register";
// Auth cookies Google only sets after a completed login.
const GOOGLE_AUTH_COOKIES = ["__Secure-1PSID", "SAPISID", "SID"];

const require = createRequire(import.meta.url);

interface PersistentLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: Record<string, unknown>,
  ): Promise<BrowserContext>;
}

// Mirror BrowserController's stealth chromium resolution.
function resolveChromium(): PersistentLauncher {
  try {
    const extra = require("playwright-extra") as {
      chromium: PersistentLauncher & { use: (plugin: unknown) => unknown };
    };
    const stealth = require("puppeteer-extra-plugin-stealth") as () => unknown;
    extra.chromium.use(stealth());
    return extra.chromium;
  } catch {
    return (require("playwright") as { chromium: PersistentLauncher }).chromium;
  }
}

// D8 — close/reopen. Open the persistent profile in this fresh process,
// confirm the spike's Google session survived a process boundary, then
// close it. The bot run below re-opens the same profile a third time.
async function verifyProfileSession(): Promise<boolean> {
  const chromium = resolveChromium();
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_DIR, {
      channel: "chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const cookies = await context.cookies("https://www.google.com");
    return cookies.some((c) => GOOGLE_AUTH_COOKIES.includes(c.name));
  } finally {
    if (context !== undefined) await context.close();
  }
}

// A no-op LLM: every reply fails to parse, so postVerifyLoop's planner
// catch stops onboarding cleanly instead of crashing. Lets the thin
// slice still prove profile-reuse + the OAuth handshake when no real
// LLM backend is configured.
class NoLLM implements LLMClient {
  readonly name = "no-llm-stub";
  async createMessage(_req: LLMRequest): Promise<LLMResponse> {
    return { text: "{}", backend: this.name };
  }
}

function resolveLLM(): { llm: LLMClient | LLMPair; real: boolean } {
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  if (orKey.length > 0) {
    // Build a single-model client directly. pickLLMPair's cheap tier
    // ships a fallbackModels list that makes OpenRouter's `models`
    // routing array exceed its 3-item cap (a 400). One vision model,
    // no fallback array, sidesteps it. Claude 3.5 Sonnet is the most
    // reliable at the structured-JSON planner output.
    return {
      llm: new OpenRouterClient({ apiKey: orKey, model: "anthropic/claude-sonnet-4.5" }),
      real: true,
    };
  }
  const hasBackend =
    (process.env.ANTHROPIC_API_KEY ?? "").length > 0 ||
    (process.env.TRUSTY_SQUIRE_MACHINE_TOKEN ?? "").length > 0;
  if (hasBackend) return { llm: pickLLMPair({ preferCheap: true }), real: true };
  return { llm: new NoLLM(), real: false };
}

// Onboarding-only mode (T12_ONBOARDING_ONLY=1). When the persistent
// profile is ALREADY authenticated with the service — a service that
// silent-SSOs you back in whenever the Google session is live, so its
// signup URL never re-shows the OAuth button — the front-half handshake
// can't be re-triggered. This mode skips it and exercises just the
// piece that still needs proving: driving the authenticated dashboard
// through post-OAuth onboarding to the API key. It reflects into the
// agent's postVerifyLoop, the same machinery the OAuth path uses.
async function runOnboardingOnly(llm: LLMClient | LLMPair): Promise<boolean> {
  const dashboardUrl =
    process.env.T12_DASHBOARD_URL ?? "https://dashboard.render.com/";
  console.error(`[T12] onboarding-only mode — dashboard: ${dashboardUrl}`);
  const browser = new BrowserController({ humanize: true });
  const steps: string[] = [];
  try {
    await browser.start();
    await browser.goto(dashboardUrl);
    await browser.wait(3);
    const agent = new SignupAgent(browser, llm);
    // postVerifyLoop is private — reflected, the same break-the-
    // encapsulation pattern the unit tests use.
    const loop = (
      agent as unknown as {
        postVerifyLoop: (a: {
          service: string;
          maxRounds: number;
          steps: string[];
        }) => Promise<Record<string, string>>;
      }
    ).postVerifyLoop.bind(agent);
    const credentials = await loop({ service: SERVICE, maxRounds: 12, steps });

    const line = "=".repeat(64);
    console.error(`\n${line}\n[T12] ONBOARDING RESULT\n${line}`);
    const apiKey = credentials["api_key"];
    if (apiKey !== undefined) {
      console.error(`[T12] ✓ API key extracted: ${apiKey}`);
    } else {
      console.error(`[T12] no API key reached through onboarding`);
    }
    console.error(`[T12] steps:`);
    steps.forEach((s, i) => console.error(`        ${i + 1}. ${s}`));
    console.error(line);
    return apiKey !== undefined;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const line = "=".repeat(64);
  console.error(`${line}\n[T12] OAuth-first thin slice — Render\n${line}`);
  console.error(`[T12] profile dir : ${CHROME_PROFILE_DIR}`);
  console.error(`[T12] service     : ${SERVICE}`);
  console.error(`[T12] signup url  : ${SIGNUP_URL}`);

  if (process.env.T12_ONBOARDING_ONLY === "1") {
    const { llm, real } = resolveLLM();
    if (!real) {
      console.error(`[T12] onboarding-only needs a real LLM backend — aborting.`);
      process.exitCode = 1;
      return;
    }
    const ok = await runOnboardingOnly(llm);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  // Step 1 — D8 close/reopen: is the spike's Google session still here?
  console.error(`[T12] verifying the persistent profile holds a Google session…`);
  let sessionOk: boolean;
  try {
    sessionOk = await verifyProfileSession();
  } catch (err) {
    console.error(`[T12] FAILED to open the profile: ${String(err)}`);
    process.exitCode = 1;
    return;
  }
  if (!sessionOk) {
    console.error(
      `[T12] No Google session in the profile. Run \`npx @trusty-squire/mcp login\` ` +
        `first, then re-run this thin slice.`,
    );
    process.exitCode = 1;
    return;
  }
  console.error(`[T12] ✓ Google session survived the process boundary (D8 close/reopen).`);

  // Step 2 — the real OAuth signup.
  const { llm, real } = resolveLLM();
  console.error(
    `[T12] onboarding LLM: ${real ? "configured" : "NONE — onboarding will stop early"}`,
  );
  console.error(`[T12] starting the OAuth signup (this re-opens the profile)…\n`);

  const bot = new UniversalSignupBot();
  const result = await bot.signup({
    service: SERVICE,
    signupUrl: SIGNUP_URL,
    oauthProvider: "google",
    llm,
  });

  console.error(`\n${line}\n[T12] RESULT\n${line}`);
  console.error(`[T12] success : ${result.success}`);
  if (result.error !== undefined) console.error(`[T12] error   : ${result.error}`);
  if (result.credentials !== undefined) {
    console.error(`[T12] credentials:`);
    for (const [k, v] of Object.entries(result.credentials)) {
      if (v !== undefined) console.error(`        ${k}: ${v}`);
    }
  }
  console.error(`[T12] steps:`);
  result.steps.forEach((s, i) => console.error(`        ${i + 1}. ${s}`));
  console.error(line);

  process.exitCode = result.success ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`[T12] crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
