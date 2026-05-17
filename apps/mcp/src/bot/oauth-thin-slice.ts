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
  type LLMClient,
  type LLMPair,
  type LLMRequest,
  type LLMResponse,
} from "./index.js";
import { CHROME_PROFILE_DIR } from "./profile.js";

const RENDER_SIGNUP_URL =
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
  const hasBackend =
    (process.env.OPENROUTER_API_KEY ?? "").length > 0 ||
    (process.env.ANTHROPIC_API_KEY ?? "").length > 0 ||
    (process.env.TRUSTY_SQUIRE_MACHINE_TOKEN ?? "").length > 0;
  if (hasBackend) return { llm: pickLLMPair({ preferCheap: true }), real: true };
  return { llm: new NoLLM(), real: false };
}

async function main(): Promise<void> {
  const line = "=".repeat(64);
  console.error(`${line}\n[T12] OAuth-first thin slice — Render\n${line}`);
  console.error(`[T12] profile dir : ${CHROME_PROFILE_DIR}`);
  console.error(`[T12] signup url  : ${RENDER_SIGNUP_URL}`);

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
    service: "Render",
    signupUrl: RENDER_SIGNUP_URL,
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
