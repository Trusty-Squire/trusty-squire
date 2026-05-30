// Per-service host allowlist seed.
//
// At store-time the vault derives a credential's `allowed_hosts` from
// the `service` metadata so the `use_credential` proxy (a later PR) has
// a sane default to advisory-check against. The list is intentionally
// small and conservative — it's a starting point, not an exhaustive
// directory. Unknown services start with an empty allowlist and the
// user populates it from the `/vault` UI.
//
// Enforcement is advisory (the proxy warns + proceeds on off-allowlist
// hosts for a trusted session). This table only seeds the default.

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
