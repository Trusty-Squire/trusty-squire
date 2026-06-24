// Credential redactor — keeps known-shape API tokens out of step
// trails / error messages / any string the bot returns in
// SignupResult or uploads to the registry.
//
// Background: 2026-05-26 — a Supabase + PlanetScale signup attempt
// dumped the actual extracted API tokens into the housekeeper's
// GitHub issue comment via the planner's `reason` field, which the
// step trail printed verbatim. Same bug also leaked a Neon token
// to issue #35. The housekeeper now redacts at the public-surface
// boundary; this module is the bot-side equivalent so step trails
// are clean BEFORE they ever leave SignupAgent.signup() — covers
// the registry-upload + roundUploader paths the housekeeper doesn't
// sit in front of.
//
// Conservative: only strips substrings matching service-specific
// prefix patterns the bot itself produces. Same set as the
// harvester's tools/archived-harvester/redact.mjs — keep them in lockstep.

const TOKEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\bsk-or-v1-[a-f0-9]{40,80}/gi,
  /\bsk-ant-[a-zA-Z0-9_\-]{40,120}/g,
  /\bsk-proj-[a-zA-Z0-9_\-]{40,200}/g,
  /\bsk-[a-zA-Z0-9]{40,60}/g,
  /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}/g,
  /\bre_[a-zA-Z0-9_]{20,}/g,
  /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}/g,
  /\bkey-[a-f0-9]{32}/g,
  /\bsntr[su]_[A-Za-z0-9_=\-]{20,}/g,
  /\brnd_[a-zA-Z0-9]{20,}/g,
  /\bpscale_tkn_[A-Za-z0-9]{30,}/gi,
  /\bsbp_[A-Za-z0-9]{30,}/gi,
  /\bnapi_[a-zA-Z0-9]{30,80}/g,
  /\br8_[a-zA-Z0-9]{30,60}/g,
  /\bphx_[A-Za-z0-9]{40,60}/g, // PostHog personal API key (lockstep w/ agent.ts)
  // rc.23 / rc.35 — Baseten (6-12 alnum . 30+ alnum)
  /\b[A-Za-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/g,
  // rc.23 / rc.34 / rc.36 — Qdrant Cloud (UUID|opaque-55+, allowing _ and - in body)
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9_\-]{30,80}\b/gi,
  // rc.23 — JWT (Convex, others)
  /\beyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/g,
  /\btsm_[A-Za-z0-9]{30,}/g,
  /\bddp_[A-Za-z0-9]{30,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{20,}/g,
  /\bcfut_[A-Za-z0-9]{40,}/g,
  /\bcfat_[A-Za-z0-9]{40,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];

// Replace each known-shape token with a redaction marker that
// preserves the prefix + last 6 chars (for distinguishing leaks of
// distinct keys in the same trail). New service prefixes go here AND
// in extractApiKeyFromText so they stay in sync.
export function redactCredentials(text: string): string {
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, (m) => {
      const sepIdx = Math.max(m.indexOf("_"), m.indexOf("-"));
      const prefix = sepIdx > 0 ? m.slice(0, sepIdx + 1) : m.slice(0, 3);
      const tail = m.slice(-6);
      return `${prefix}REDACTED…${tail}`;
    });
  }
  return out;
}

// Memory-overhaul Phase 2 — DOM-secret scrub for the EVIDENCE-UPLOAD path.
// Centralizing the full per-round DOM on every failure (so a failure can be
// re-inspected without reproducing it) multiplies the sensitive-data surface
// in the registry. On top of the key-prefix redactor above, the DOM can carry
// session material that is NOT a known API-key shape: captcha response tokens,
// Authorization/Cookie headers leaked into inline JS or attributes, and the
// value typed into a password field. Scrub them BEFORE any DOM leaves the box.
//
// Best-effort defense-in-depth, NOT a security boundary — regex over HTML
// can't catch every shape, but it removes the obvious high-value secrets. The
// 7-day retention sweep + operator-only trust boundary remain the backstops.
// (Screenshot pixel redaction is out of scope — see the design doc.)
const HTML_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Captcha response tokens — as a hidden input value…
  [
    /(\bname=["'](?:cf-turnstile-response|g-recaptcha-response|h-captcha-response)["'][^>]*\bvalue=["'])[^"']{16,}(["'])/gi,
    "$1REDACTED$2",
  ],
  // …or assigned in inline JS / JSON config.
  [
    /(["']?(?:cf-turnstile-response|g-recaptcha-response|h-captcha-response)["']?\s*[:=]\s*["'])[^"']{16,}(["'])/gi,
    "$1REDACTED$2",
  ],
  // Authorization / Cookie / api-key headers in attributes or inline JS.
  [
    /(["']?(?:authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*["'])[^"'\n]{12,}(["'])/gi,
    "$1REDACTED$2",
  ],
  [/(\bBearer\s+)[A-Za-z0-9._\-]{16,}/gi, "$1REDACTED"],
  // A populated password input's value (either attribute order).
  [
    /(<input\b[^>]*\btype=["']password["'][^>]*\bvalue=["'])[^"']+(["'])/gi,
    "$1REDACTED$2",
  ],
  [
    /(<input\b[^>]*\bvalue=["'])[^"']+(["'][^>]*\btype=["']password["'])/gi,
    "$1REDACTED$2",
  ],
];

export function redactHtml(html: string): string {
  let out = redactCredentials(html);
  for (const [re, repl] of HTML_SECRET_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}
