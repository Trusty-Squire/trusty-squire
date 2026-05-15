// ASN-class detection for the machine running the bot.
//
// Trusty Squire's whole captcha strategy bets on the bot egressing
// through a residential IP. When users install on a laptop/desktop
// at home, that bet pays off — Google + Cloudflare score the session
// as a real user. When users install on a Codespace, Replit, or
// VPS (Hetzner, DO, AWS), the bet fails: reCAPTCHA v2 will silently
// reject the session client-side-solve regardless of how clean the
// fingerprint is.
//
// We don't try to *fix* this at runtime — fixing requires either
// residential proxies (out of scope per CLAUDE.md) or asking the
// user to move. What we do is:
//   1. At install time: warn the user explicitly so they know what
//      to expect.
//   2. At signup time: log the asn class with every captcha_blocked
//      event, so we can answer "what % of failures are datacenter
//      egress?" with data, not vibes.
//
// Both call into this module. The classifier is intentionally
// conservative — ambiguous orgs (university networks, mobile carriers
// with overlapping ASNs, cloudflare-warp users) get bucketed as
// "unknown" rather than mislabeled.

export type AsnClass = "residential" | "datacenter" | "unknown";

export interface AsnInfo {
  ip: string;
  asn: string | null;
  org: string | null;
  country: string | null;
  class: AsnClass;
}

// Datacenter org-name substrings. Matched case-insensitively against
// the `org` field returned by ipinfo. The list is the top hyperscaler
// + bare-metal providers plus the ones we've seen vibe-coders actually
// use. False positives here are okay (a user on "Amazon Eero" residential
// service would get a "datacenter" warning), but the converse — false
// negatives — would silently mislead the captcha analytics.
const DATACENTER_PATTERNS: readonly string[] = [
  "amazon",          // AWS, includes Amazon Eero ⚠ false positive risk
  "microsoft",       // Azure
  "google llc",      // GCP — careful not to match "Google Fiber"
  "googlecloud",
  "digitalocean",
  "linode",
  "akamai",
  "fastly",
  "cloudflare",      // Cloudflare-as-origin or Warp clients
  "hetzner",
  "ovh",
  "scaleway",
  "vultr",
  "leaseweb",
  "contabo",
  "oracle cloud",
  "alibaba",
  "tencent cloud",
  "hostinger",
  "godaddy",
  "namecheap",
  "fly.io",
  "render",
  "vercel",
  "netlify",
  "railway",
  "supabase",
  "github",          // Codespaces egresses through GitHub's Azure footprint, often shows here
];

// Residential ISP org-name substrings. Same matching rules. The list
// skews US/UK/DE because that's our user concentration; it's fine to
// be incomplete here — unmatched orgs fall through to `unknown`, which
// is the right default when we're not sure.
const RESIDENTIAL_PATTERNS: readonly string[] = [
  "comcast",
  "xfinity",
  "spectrum",
  "charter",
  "at&t",
  "verizon",
  "t-mobile",
  "sprint",
  "cox",
  "centurylink",
  "frontier",
  "google fiber",
  "starlink",
  "british telecom",
  "bt group",
  "sky broadband",
  "virgin media",
  "talktalk",
  "vodafone",
  "deutsche telekom",
  "telekom",
  "free sas",
  "orange s.a.",
  "rogers",
  "bell canada",
  "telus",
  "shaw cable",
];

function classify(org: string | null): AsnClass {
  if (org === null) return "unknown";
  const o = org.toLowerCase();
  for (const p of DATACENTER_PATTERNS) {
    if (o.includes(p)) return "datacenter";
  }
  for (const p of RESIDENTIAL_PATTERNS) {
    if (o.includes(p)) return "residential";
  }
  return "unknown";
}

// Look up the public IP this machine is egressing from, plus its ASN
// classification. Best-effort: ipinfo.io's free tier is 50k req/month
// with no auth, which is well above any realistic install volume.
//
// Returns `null` on network error rather than throwing — callers
// generally want to degrade gracefully (skip the warning, log
// "unknown" in telemetry) when the lookup can't complete.
export async function detectAsn(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = 5000,
): Promise<AsnInfo | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://ipinfo.io/json", {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object") return null;
    const obj = body as Record<string, unknown>;
    const ip = typeof obj.ip === "string" ? obj.ip : "";
    const org = typeof obj.org === "string" ? obj.org : null;
    const country = typeof obj.country === "string" ? obj.country : null;
    // ipinfo's `org` field is "AS24940 Hetzner Online GmbH" — split
    // out the AS number when possible since downstream consumers
    // (analytics, dashboards) want them separately.
    let asn: string | null = null;
    if (org !== null) {
      const m = /^(AS\d+)\s+(.+)$/.exec(org);
      if (m !== null && typeof m[1] === "string") asn = m[1];
    }
    return { ip, asn, org, country, class: classify(org) };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Exposed for unit tests.
export const _internal = { classify };
