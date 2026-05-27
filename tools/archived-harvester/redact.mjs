// Credential redactor — sanitises step trails / error messages /
// arbitrary user-facing text before it hits a public surface (GitHub
// issue comment, Telegram message, failure-report.json).
//
// Background: 2026-05-26 — a Supabase + PlanetScale signup attempt
// dumped the actual extracted API tokens into the GitHub issue
// comment via the planner's `reason` field, which the harvester's
// step trail printed verbatim. GitHub Secret Scanning flagged both.
// Same bug also leaked a Neon token to issue #35 (unflagged because
// Neon isn't in GitHub's partner program — silent until I found it).
//
// Fix: run every piece of text destined for a public surface through
// this redactor first. Conservative — only strips substrings that
// match KNOWN service-prefix patterns the bot itself produces, so
// false positives on IDs / hashes / unrelated alphanumerics are zero.
// New service prefixes go here AND in agent.ts's extractApiKeyFromText
// regex library so they stay in sync.

const TOKEN_PATTERNS = [
  // OpenRouter / Anthropic / OpenAI families
  /\bsk-or-v1-[a-f0-9]{40,80}/gi,
  /\bsk-ant-[a-zA-Z0-9_\-]{40,120}/g,
  /\bsk-proj-[a-zA-Z0-9_\-]{40,200}/g,
  /\bsk-[a-zA-Z0-9]{40,60}/g,
  // Stripe (secret only — pk_ is public, intentionally not redacted
  // because the user may include pk_live_ in test context)
  /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}/g,
  // Mail
  /\bre_[a-zA-Z0-9_]{20,}/g,                       // Resend
  /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}/g, // SendGrid
  /\bkey-[a-f0-9]{32}/g,                            // Mailgun
  // Telemetry / observability
  /\bsntr[su]_[A-Za-z0-9_=\-]{20,}/g,               // Sentry
  // Cloud / PaaS
  /\brnd_[a-zA-Z0-9]{20,}/g,                        // Render
  /\bpscale_tkn_[A-Za-z0-9]{30,}/gi,                // PlanetScale
  /\bsbp_[A-Za-z0-9]{30,}/gi,                       // Supabase
  // DB / vector
  /\bnapi_[a-zA-Z0-9]{30,80}/g,                     // Neon
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9_\-]{30,80}\b/gi, // Qdrant Cloud (rc.36)
  // AI / inference
  /\br8_[a-zA-Z0-9]{30,60}/g,                       // Replicate
  /\b[A-Za-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/g,     // Baseten (rc.35 mixed-case)
  // JWT (Convex etc)
  /\beyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g,
  // Infra creds we don't want in step trails either
  /\btsm_[A-Za-z0-9]{30,}/g,                        // Trusty Squire machine token
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,                   // Svix / Resend webhook secret
  /\bcfut_[A-Za-z0-9]{40,}/g,                       // Cloudflare user-token (cfut_)
  /\bcfat_[A-Za-z0-9]{40,}/g,                       // Cloudflare API token (cfat_)
  /\bnpm_[A-Za-z0-9]{30,}/g,                        // npm automation token
];

// Replace each known-shape token with a redaction marker that
// preserves the prefix (for debugging context) + a short suffix (for
// distinguishing leaks of distinct keys in the same trail).
//
// Example: "sbp_61c3fa224c…047babab" → "sbp_REDACTED…7babab"
export function redactCredentials(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m) => {
      const dotIdx = m.indexOf("_") >= 0 ? m.indexOf("_") + 1 : m.indexOf("-") + 1;
      const prefix = dotIdx > 0 ? m.slice(0, dotIdx) : m.slice(0, 3);
      const tail = m.slice(-6);
      return `${prefix}REDACTED…${tail}`;
    });
  }
  return out;
}

// Apply over an array of step trail lines. Returns a new array.
export function redactSteps(steps) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((s) => redactCredentials(s));
}
