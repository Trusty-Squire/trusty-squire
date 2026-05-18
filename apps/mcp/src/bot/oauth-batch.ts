// oauth-batch.ts — batch OAuth-first signup sweep. DEV HARNESS
// (excluded from the published build, like the other probes).
//
// Runs the full OAuth-first signup flow against each candidate that
// the affordance probe found reachable, collects per-service results,
// and prints a summary. Used to iterate the post-OAuth onboarding to
// green across the sweep set.
//
// Run:  OPENROUTER_API_KEY=... node dist/bot/oauth-batch.js [filter]
//   filter — optional substring; run only matching services.

import { UniversalSignupBot, OpenRouterClient, type LLMClient } from "./index.js";

const TARGETS: ReadonlyArray<{ name: string; url: string }> = [
  { name: "Resend", url: "https://resend.com/signup" },
  { name: "Plunk", url: "https://app.useplunk.com/signup" },
  { name: "Hunter", url: "https://hunter.io/users/sign_up" },
  { name: "IPInfo", url: "https://ipinfo.io/signup" },
  { name: "PostHog", url: "https://app.posthog.com/signup" },
  { name: "Koyeb", url: "https://app.koyeb.com/auth/signup" },
  { name: "Netlify", url: "https://app.netlify.com/signup" },
  { name: "SendPulse", url: "https://login.sendpulse.com/registration/" },
  { name: "Back4App", url: "https://www.back4app.com/signup" },
];

function makeLLM(): LLMClient {
  const key = process.env.OPENROUTER_API_KEY ?? "";
  if (key.length === 0) throw new Error("set OPENROUTER_API_KEY");
  // Single reliable vision model — onboarding-planner quality matters
  // more than cost here, and one model sidesteps OpenRouter's 3-item
  // `models` cap on the fallback list.
  return new OpenRouterClient({ apiKey: key, model: "anthropic/claude-sonnet-4.5" });
}

interface Row {
  name: string;
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const filter = process.argv[2]?.toLowerCase();
  const targets = filter
    ? TARGETS.filter((t) => t.name.toLowerCase().includes(filter))
    : TARGETS;
  const line = "=".repeat(64);
  console.error(`${line}\n[batch] OAuth-first sweep — ${targets.length} service(s)\n${line}`);

  const rows: Row[] = [];
  for (const t of targets) {
    console.error(`\n${line}\n[batch] ${t.name} — ${t.url}\n${line}`);
    let pass = false;
    let detail = "";
    try {
      const result = await new UniversalSignupBot().signup({
        service: t.name,
        signupUrl: t.url,
        oauthProvider: "google",
        llm: makeLLM(),
      });
      const key = result.credentials?.api_key;
      pass = result.success && key !== undefined;
      detail = pass ? `key=${key}` : (result.error ?? "no credentials");
      console.error(`[batch] ${t.name}: ${pass ? "PASS" : "FAIL"} — ${detail}`);
      // Last steps — the diagnostic trail for a failure.
      result.steps.slice(-10).forEach((s) => console.error(`    ${s}`));
    } catch (err) {
      detail = `CRASH: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[batch] ${t.name}: ${detail}`);
    }
    rows.push({ name: t.name, pass, detail });
  }

  console.error(`\n${line}\n[batch] SUMMARY\n${line}`);
  for (const r of rows) {
    console.error(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(12)} ${r.detail.slice(0, 90)}`);
  }
  const passed = rows.filter((r) => r.pass).length;
  console.error(`\n[batch] ${passed}/${rows.length} passed`);
  process.exitCode = passed === rows.length ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(`[batch] crashed: ${err instanceof Error ? err.stack : String(err)}`);
  process.exitCode = 1;
});
