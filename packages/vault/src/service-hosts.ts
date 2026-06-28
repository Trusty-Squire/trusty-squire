// Per-service host allowlist seed.
//
// At store-time the vault derives a credential's `allowed_hosts` from
// the `service` metadata so the `use_credential` proxy has a sane
// default to enforce against. The list is intentionally small and
// conservative — it's a starting point, not an exhaustive directory.
// Unknown services start with an empty allowlist and the user populates
// it from the `/vault` UI.
//
// Enforcement is HARD: the proxy rejects any off-allowlist host with a
// 403 (AllowlistViolationError) before decrypt/dispatch — it does not
// "warn and proceed". This table only seeds the default the user edits.

// Keyed by a normalised service slug (lowercase, alphanumerics only) so
// "OpenAI", "open-ai", and "openai" all resolve to the same entry.
export const KNOWN_SERVICE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  github: ["api.github.com"],
  stripe: ["api.stripe.com"],
  resend: ["api.resend.com"],
  sentry: ["sentry.io"],
  openrouter: ["openrouter.ai"],
  ipinfo: ["ipinfo.io"],
  postmark: ["api.postmarkapp.com"],
  render: ["api.render.com"],
  vercel: ["api.vercel.com"],
  railway: ["railway.app"],
  cloudflare: ["api.cloudflare.com"],
  supabase: ["api.supabase.com"],
  netlify: ["api.netlify.com"],
  posthog: ["app.posthog.com"],
  planetscale: ["api.planetscale.com"],
  neon: ["console.neon.tech"],
  flyio: ["api.fly.io"],
  fly: ["api.fly.io"],
  mailgun: ["api.mailgun.net"],
  sendgrid: ["api.sendgrid.com"],
  twilio: ["api.twilio.com"],
  digitalocean: ["api.digitalocean.com"],
  mailersend: ["api.mailersend.com"],
  koyeb: ["app.koyeb.com"],
  groq: ["api.groq.com"],
  huggingface: ["huggingface.co"],
  // Google Cloud Platform / Firebase — keys are EXTRACTED on the console
  // (console.cloud.google.com / console.firebase.google.com) but USED against
  // the API surface, never the console. The operator surface relies on these
  // defaults so a console-extracted key gets the right egress without the agent
  // having to know it. normaliseService strips non-alphanumerics:
  // "GCP"→"gcp", "google-cloud"→"googlecloud", "Firebase"→"firebase".
  gcp: ["googleapis.com"],
  googlecloud: ["googleapis.com"],
  googlecloudplatform: ["googleapis.com"],
  firebase: ["googleapis.com", "firebaseio.com", "identitytoolkit.googleapis.com"],
  fcm: ["fcm.googleapis.com"],
  firebasecloudmessaging: ["fcm.googleapis.com"],
  // Alpaca — brokerage/market-data API. Paper-trading, live trading, and
  // market data are SEPARATE hosts; seed all three so a paper key (the
  // common case) works without an edit. normaliseService("Alpaca") → "alpaca".
  alpaca: [
    "paper-api.alpaca.markets",
    "api.alpaca.markets",
    "data.alpaca.markets",
  ],
  // FRED — St. Louis Fed economic data. Service is usually typed "FRED";
  // the API lives on the stlouisfed.org host. Key both common slugs.
  fred: ["api.stlouisfed.org"],
  stlouisfed: ["api.stlouisfed.org"],
  // fal.ai — AI inference. Keys auth `Authorization: Key <id>:<secret>`
  // against the run/queue hosts. normaliseService("fal.ai") → "falai".
  falai: ["fal.run", "rest.alpha.fal.ai", "queue.fal.run"],
  fal: ["fal.run", "rest.alpha.fal.ai", "queue.fal.run"],
};

// Normalise a free-text service name to the slug the table is keyed on.
function normaliseService(service: string): string {
  return service.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Derive the default host allowlist for a service. Returns a fresh
// array (callers persist + later mutate it) and an empty array for
// unknown services — never throws.
export function deriveAllowedHosts(service: string | null | undefined): string[] {
  if (typeof service !== "string" || service.length === 0) return [];
  const hosts = KNOWN_SERVICE_HOSTS[normaliseService(service)];
  return hosts === undefined ? [] : [...hosts];
}
