// oauth-affordance-probe.ts — read-only OAuth-coverage sweep. DEV
// HARNESS (excluded from the published build, like the other probes).
//
// The OAuth-first path can only help a service that actually OFFERS a
// "Sign in with Google/GitHub" affordance. This navigates each
// candidate's signup page and reports what findOAuthButton would
// detect — no signup, no account creation, no LLM. It answers "of the
// original sweep set, which are OAuth-first-reachable at all?"
//
// Uses a THROWAWAY profile dir so a service the real bot already has
// an account on still shows its fresh signup page.
//
// Run:  npx tsx src/bot/oauth-affordance-probe.ts

import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserController } from "./browser.js";
import { findOAuthButton } from "./agent.js";

// Dev-infra candidates drawn from test-services.md, CLAUDE.md's
// verified-signups table, and the CEO plan's Gate-1 re-sweep.
const TARGETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "Resend", url: "https://resend.com/signup" },
  { name: "Loops", url: "https://app.loops.so/signup" },
  { name: "Plunk", url: "https://app.useplunk.com/signup" },
  { name: "Brevo", url: "https://www.brevo.com/free-account/" },
  { name: "MailerSend", url: "https://app.mailersend.com/signup" },
  { name: "Postmark", url: "https://account.postmarkapp.com/sign_up" },
  { name: "Mailgun", url: "https://signup.mailgun.com/new/signup" },
  { name: "Hunter", url: "https://hunter.io/users/sign_up" },
  { name: "IPInfo", url: "https://ipinfo.io/signup" },
  { name: "PostHog", url: "https://app.posthog.com/signup" },
  { name: "Koyeb", url: "https://app.koyeb.com/auth/signup" },
  { name: "Axiom", url: "https://app.axiom.co/register" },
  { name: "Netlify", url: "https://app.netlify.com/signup" },
  { name: "Sentry", url: "https://sentry.io/signup/" },
  { name: "Mistral", url: "https://auth.mistral.ai/ui/registration" },
  { name: "DeepSeek", url: "https://platform.deepseek.com/sign_up" },
  { name: "SendPulse", url: "https://login.sendpulse.com/registration/" },
  { name: "Back4App", url: "https://www.back4app.com/signup" },
];

async function main(): Promise<void> {
  const browser = new BrowserController({
    profileDir: join(tmpdir(), "ts-oauth-affordance-probe"),
    humanize: false,
  });
  await browser.start();
  // Optional comma-separated name filter — re-probe a subset.
  const filter = process.argv[2]?.toLowerCase().split(",").filter((s) => s.length > 0);
  const targets = filter
    ? TARGETS.filter((t) => filter.some((f) => t.name.toLowerCase().includes(f)))
    : TARGETS;
  let reachable = 0;
  try {
    for (const t of targets) {
      let row: string;
      try {
        await browser.goto(t.url);
        await browser.wait(6);
        await browser.waitForFormReady();
        let inv = await browser.extractInteractiveElements();
        let google = findOAuthButton(inv, "google");
        let github = findOAuthButton(inv, "github");
        // Mirror the bot's async-retry — SSO buttons often load late.
        // Two extra passes: slow SPAs can take 10s+ to paint the form.
        for (let r = 0; r < 2 && google === null && github === null; r++) {
          await browser.wait(6);
          inv = await browser.extractInteractiveElements();
          google = findOAuthButton(inv, "google");
          github = findOAuthButton(inv, "github");
        }
        const tag = `${google !== null ? "G" : "·"}${github !== null ? "H" : "·"}`;
        const hit = google ?? github;
        if (hit !== null) reachable += 1;
        row =
          `  ${tag}  ${t.name.padEnd(12)} ${String(inv.length).padStart(3)} els` +
          (hit !== null
            ? `  → ${JSON.stringify(
                (hit.visibleText ?? hit.iconLabel ?? hit.ariaLabel ?? hit.href ?? "").slice(0, 48),
              )}`
            : "");
      } catch (err) {
        row = `  ??  ${t.name.padEnd(12)} ERROR: ${(err instanceof Error ? err.message : String(err)).slice(0, 90)}`;
      }
      console.error(row);
    }
  } finally {
    await browser.close();
  }
  console.error(
    `\nOAuth-first reachable (a Google/GitHub affordance detected): ` +
      `${reachable}/${targets.length}`,
  );
}

main().catch((err: unknown) => {
  console.error(`[probe] crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
