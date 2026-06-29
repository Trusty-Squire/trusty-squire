// credential-text.ts — pull a credential VALUE out of a blob of visible page
// text, and reject candidates that are truncated displays or password-manager
// UI noise. Carved out of agent.ts (the retired universal-bot monolith); these
// are the browser-free, regex-driven extraction predicates the provision
// session + skill replay paths share.
//
// Distinct from credential-shape.ts: that module answers "is this string
// shaped like a credential" (a tight host-side gate); this one answers "given a
// page of text, WHICH substring is the credential" (service-prefix + labeled
// regex library) plus the two candidate-rejection helpers replay uses.

// Real API keys / bearer tokens are short (Stripe ~32, JWT ~hundreds
// but our labeled patterns don't target JWTs). Captcha challenge
// tokens are very long: g-recaptcha-response runs ~500-2000 chars and
// cf-turnstile-response is similar. A 100-char ceiling cleanly admits
// real keys and rejects every captcha token shape we've seen.
const MAX_CREDENTIAL_LENGTH = 100;

// Substrings that, if present in a candidate, mark it as a
// challenge/cookie token rather than a credential. Cloudflare clearance
// cookies (`__cf`, `cf_clearance`), CDN challenge paths (`cdn-cgi`),
// and the visible field/param names of the two captcha widgets.
const CAPTCHA_TOKEN_MARKERS: readonly string[] = [
  "__cf",
  "cf_clearance",
  "cdn-cgi",
  "cf-turnstile-response",
  "g-recaptcha-response",
  "h-captcha-response",
];

// Distinctive service key prefixes. If a *labeled* match's value
// embeds one of these NOT at its start, the regex straddled glued UI
// text on a dense dashboard (e.g. Render's API-keys list rendered as
// "...Name bot-key Menu Key rnd_xxxx" with no separators) — the real
// key starts at the prefix, so the labeled match is contaminated and
// must be rejected. A clean labeled key either starts with its prefix
// (then the prefixed patterns above already caught it) or carries no
// known prefix at all.
const EMBEDDED_KEY_PREFIXES: readonly string[] = [
  "rnd_",
  "phc_",
  "sk_live_",
  "sk_test_",
  "pk_live_",
  "pk_test_",
];

// True when `capturedKey` is followed by a truncation marker (`...`
// or the Unicode ellipsis `…`) in `sourceText`. That marker is the
// signal that the visible display masked the full secret — the
// regex captured everything up to but not including the marker, so
// the value LOOKS valid but is short. Used by F10's
// extract-via-Copy-button recovery path; without this check, the
// bot accepts the truncated value, stores it, and the user discovers
// the failure only when their next API call returns 401.
export function isTruncatedCapture(sourceText: string, capturedKey: string): boolean {
  const idx = sourceText.indexOf(capturedKey);
  if (idx < 0) return false;
  const after = sourceText.slice(
    idx + capturedKey.length,
    idx + capturedKey.length + 10,
  );
  // Whitespace OK between key and ellipsis (some modals render as
  // "sk-or-v1-xxxx ..."). Three OR MORE dots; two dots are ordinary
  // punctuation and would false-positive on e.g. "key value.." in
  // help text.
  return /^\s*(?:\.{3,}|…)/.test(after);
}

// Pull an API key out of the *visible* page text.
//
// Two strategies, in priority order:
//   1. Known service-specific prefixes (re_, sk_live_, …) — high
//      confidence, the prefix itself is the proof.
//   2. Labeled patterns ("api key: <value>") — lower confidence, so
//      they carry guard rails: the value must sit IMMEDIATELY after
//      the label (a small bounded gap of spaces/colon/equals, NOT
//      arbitrary whitespace that could span unrelated page sections),
//      must be under MAX_CREDENTIAL_LENGTH, and must not look like a
//      captcha/cookie token. Without these, a `g-recaptcha-response`
//      value or a session token elsewhere in the body could be
//      mistaken for `credentials.api_key`.
export function extractApiKeyFromText(text: string): string | null {
  const prefixed: readonly RegExp[] = [
    /\bre_[a-zA-Z0-9_]{20,}\b/, // Resend (key body contains underscores)
    /\bsk_(?:live|test)_[a-zA-Z0-9]{20,}\b/, // Stripe secret
    // NOTE: client-embedded PUBLIC keys are deliberately NOT matched —
    // Stripe publishable (pk_live_/pk_test_) and PostHog project
    // (phc_) keys ship in the client-side JS of every site that uses
    // those vendors, so finding one on a page means "this service
    // embeds Stripe/PostHog", not "here is the user's credential".
    // Each produced a false success on Mistral (its billing pk_live_,
    // then its analytics phc_, surfaced as the api_key).
    // Plunk is the EXCEPTION: its API key is `pk_<hex>` (e.g.
    // pk_e063df9b5…) and IS the user's credential, shown in plaintext on
    // the dashboard under an "API Key" label. The pure-hex body after the
    // prefix distinguishes it from Stripe publishable keys (pk_live_/
    // pk_test_ — a "live"/"test" segment, not hex), so this can't re-open
    // the embedded-public-key false-positive the note above warns about.
    /\bpk_[a-f0-9]{24,}\b/, // Plunk (hex public/API key — NOT Stripe pk_live_/pk_test_)
    /\bkey-[a-f0-9]{32}\b/, // Mailgun
    /\bSG\.[a-zA-Z0-9_\-]{20,}\.[a-zA-Z0-9_\-]{20,}\b/, // SendGrid
    /\brnd_[a-zA-Z0-9]{20,}\b/, // Render
    /\bsntry[su]_[A-Za-z0-9_=\-]{20,}/, // Sentry org/user auth token
    // Neon serverless Postgres. Modal renders `napi_<48-char-alnum>` and
    // also shows a truncated `napi_xxx…` in the visible text below the
    // input field. Without the prefix here, the bot saw the truncated
    // display, isTruncatedCapture rejected the partial value, every
    // pass returned null, and the planner gave up despite the full key
    // being in the input field's `value` attribute. rc.14 — surfaced
    // during the harvester rc.13 pass on Neon.
    /\bnapi_[a-zA-Z0-9]{30,80}\b/, // Neon
    // 0.8.3-rc.1 — typeform personal access tokens. Shape
    // `tfp_<alnum-with-underscore>` length 40-80. Surfaced during the
    // 2026-05-29 retest where the planner SAW the token (quoted in
    // reason) but no regex matched, so extractCredentials returned
    // null and the bot bailed `oauth_onboarding_failed`.
    /\btfp_[A-Za-z0-9_]{40,80}\b/, // Typeform
    // Replicate API tokens. `r8_<40-char alnum>` per their docs. Shown
    // in the table row after Create. The post-verify loop iterates,
    // adds rows, but extractCredentials returned null every round
    // until rc.20 because no regex matched. Added defensively after
    // the rc.13 verification pass showed Replicate burning the full
    // 12-round budget filling-creating tokens nobody could extract.
    /\br8_[a-zA-Z0-9]{30,60}\b/, // Replicate
    // rc.23 — added after the post-rc.22 registry-snapshot review of
    // 200 failed signups. Each pattern matches a token shape the
    // bot's planner had already QUOTED in its `reason` field (i.e.
    // the credential was visible on the page, just not in a shape
    // any prior regex recognised). The redact.{ts,mjs} pattern set
    // stays in lockstep with these.
    /\bpscale_tkn_[A-Za-z0-9]{30,60}\b/, // PlanetScale Service Token
    /\bsbp_[a-zA-Z0-9]{30,80}\b/, // Supabase Personal Access Token
    // Baseten: `<6-12 alnum>.<30+ alnum>`. The dot separator + length
    // bounds on both sides distinguish it from version strings (too
    // short on either side). rc.35 — relaxed the prefix to mixed-case
    // after the rc.33 broad sweep showed a Baseten key whose prefix
    // had uppercase letters: `HP9tFTtm.txDl4vv7ayYsTwx9dQea47ylRdN4Brk3`.
    /\b[A-Za-z0-9]{6,12}\.[A-Za-z0-9]{30,50}\b/, // Baseten
    // Qdrant Cloud: `<UUID>|<55-char opaque>` — a literal pipe between
    // a key id and the secret body. Unique enough that no false-
    // positive guard is needed.
    //
    // rc.34/rc.36 — extended the secret-body character class to
    // include underscore + hyphen. rc.35 broad sweep surfaced
    // another Qdrant shape with mid-body hyphens:
    // `<UUID>|e8L7oyi-5fHa327u7x-IQN6WivtPlpIVjT-giIsrXDZW7P-8i2G9Pw`.
    // [A-Za-z0-9_-] covers both observed shapes; the {30,80} length
    // bound + UUID prefix keep false-positive risk near zero.
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[A-Za-z0-9_\-]{30,80}\b/i, // Qdrant
    // JWT (eyJ...eyJ...sig) — Convex's API "token" is a JWT. Other
    // services may emit JWTs as bearer secrets too. Three-segment
    // base64url with literal dots. Conservative bounds — under 20
    // chars per segment is almost never a real JWT.
    /\beyJ[A-Za-z0-9_\-]{20,}\.eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\b/, // JWT
    // Zeabur's API key — `sk-<28-40 lowercase alnum>`. Shorter than
    // OpenAI legacy (which is 40+ mixed-case). The lowercase-only
    // character class differentiates from OpenAI legacy so this
    // pattern only fires on Zeabur-style keys. Surfaced from the
    // rc.23 snapshot review.
    /\bsk-[a-z0-9]{28,38}\b/, // Zeabur
    // PostHog PERSONAL API key — `phx_<43+ alnum>`. MEASURED 2026-06-24: the
    // post-OAuth create-personal-api-key flow mints a `phx_`-prefixed secret —
    // the planner SAW it (and even OCR-transcribed it with errors), but no regex
    // matched so the DOM extractor stored nothing and the run bailed
    // oauth_onboarding_failed while a real key sat on the page. The {40,60}
    // bound keeps it clear of short prefixed noise. Deliberately NOT matching
    // the `phc_` PROJECT key —
    // that's a PUBLIC analytics key embedded in client JS on every PostHog site
    // (see extract-credentials.test "ignores a PostHog project key").
    /\bphx_[A-Za-z0-9]{40,60}\b/, // PostHog personal API key
    // OpenRouter, Anthropic, OpenAI — these are the dominant
    // OAuth-completed-then-copy-needed services. Specific-prefix
    // patterns first so a labeled-pattern fallback isn't load-
    // bearing for them. Putting `sk-or-v1-` before `sk-` so it wins
    // when both could match (cosmetic; both capture the same value).
    // 0.6.15-rc.8 — character-class anchored so the greedy match
    // doesn't glue trailing modal text. extractText() returns body
    // as one concatenated string, so a key followed by "Please copy
    // this" with no separator looked like `sk-or-v1-<64hex>Please…`.
    // The hex-only class terminates at the first non-hex char.
    /\bsk-or-v1-[a-f0-9]{40,80}/i, // OpenRouter (sk-or-v1-<64hex>)
    /\bsk-ant-[a-zA-Z0-9_-]{40,120}/, // Anthropic (sk-ant-<urlsafe-b64>)
    /\bsk-proj-[a-zA-Z0-9_-]{40,200}/, // OpenAI project key
    /\bsk-[a-zA-Z0-9]{40,60}/, // OpenAI legacy (`sk-` + ~48 chars, no dashes)
  ];
  for (const pattern of prefixed) {
    const match = text.match(pattern);
    if (match !== null) return match[0];
  }

  // Labeled patterns. The label and value MUST be separated by a real
  // separator — a colon/equals, or whitespace — `(?:[ \t]*[:=][ \t]*|[ \t]+)`,
  // never a newline. A MANDATORY separator is what keeps the regex from
  // latching the label onto glued dashboard nav text: a sidebar
  // rendering "API Keys" "Webhooks" "Settings" as adjacent links
  // concatenates in textContent to "API KeysWebhooksSettings…", and an
  // optional-gap regex would capture "sWebhooksSettings…" as the key
  // (Resend false-positive). Requiring `:`/`=`/space means "API Key"
  // followed immediately by a letter does not match.
  const labeled: readonly RegExp[] = [
    /(?:api[_\s-]?key|access[_\s-]?token|secret[_\s-]?key)(?:[ \t]*[:=][ \t]*|[ \t]+)([a-zA-Z0-9_\-]{20,})/i,
    /\b[Bb]earer[ \t]+([a-zA-Z0-9_\-.]{30,})/,
    // UUID-style tokens (Railway uses bare UUIDs for API tokens; some
    // smaller services do too). MUST be labeled — bare UUIDs appear all
    // over dashboards as trace IDs, project IDs, and request IDs, so an
    // unlabeled UUID regex would false-positive on the first error page
    // the bot lands on. The label set is broader than the prefix-style
    // labeled regex above because Railway specifically renders "Token"
    // (not "API key") next to the value.
    /(?:api[_\s-]?token|api[_\s-]?key|access[_\s-]?token|new[_\s-]?token|\btoken|\bsecret)(?:[ \t\n]*[:=][ \t\n]*|[ \t\n]+)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i,
  ];
  for (const pattern of labeled) {
    const match = text.match(pattern);
    const candidate = match?.[1];
    if (candidate === undefined) continue;
    // A captcha challenge token: too long for a real key, and/or
    // carries a known cookie/widget marker.
    if (candidate.length > MAX_CREDENTIAL_LENGTH) continue;
    const lower = candidate.toLowerCase();
    if (CAPTCHA_TOKEN_MARKERS.some((marker) => lower.includes(marker))) continue;
    // Contaminated: the labeled match straddled glued dashboard text
    // onto a real key (the key prefix sits mid-candidate, not at 0).
    if (EMBEDDED_KEY_PREFIXES.some((p) => lower.indexOf(p) > 0)) continue;
    return candidate;
  }

  return null;
}

// Password-manager / autofill UI affordances that render as short
// word-tokens on credential pages. A render API-keys page ships a
// "Save to 1Password" / "1Password" autofill button next to the real
// `rnd_…` key; LastPass, Bitwarden, and Dashlane do the same. These
// strings are alphanumeric, often carry a digit ("1Password"), and sit
// EARLIER in DOM order than the credential — so the validator-blind
// candidate-scan tiers used to return them as the
// "credential" and the downstream length validator then rejected them
// (the 0DTW2V66 render skill: `got="1Password" length 9 below min 32`).
// They are never credentials; reject them at the candidate layer so the
// scan moves on to the real key instead of the right key being shadowed
// by a UI word. Matched case-insensitively as a whole token (the
// candidates the scan tiers feed in are already whitespace-trimmed
// single tokens).
const CREDENTIAL_NOISE_TOKENS: readonly string[] = [
  "1password",
  "lastpass",
  "bitwarden",
  "dashlane",
  "keepass",
  "keeper",
  "nordpass",
  "proton pass",
  "protonpass",
  "autofill",
  "passwords",
  // Cookie-consent widget vocabulary (CookieScript/OneTrust-class banners
  // render these as checkbox values and category labels on EVERY page,
  // earlier in DOM order than any credential — zilliz's banner fed
  // "personalization" to the validator-shaped scan tier as the "key").
  // Whole-token equality with a generic English word is never a real
  // credential, so rejecting these costs nothing.
  "necessary",
  "analytics",
  "personalization",
  "personalisation",
  "advertising",
  "advertisement",
  "marketing",
  "functional",
  "preferences",
  "statistics",
  "performance",
  "targeting",
  "unclassified",
  "security",
];

// Verb-prefixed UI affordances ("Save to 1Password", "Copy to
// clipboard", "Add to vault"). The candidate-scan tiers tokenize on
// whitespace so a multi-word affordance rarely survives as one
// candidate — but extractText()/innerText passes glue it together, so
// guard the leading verbs too.
const CREDENTIAL_NOISE_PREFIXES: readonly string[] = [
  "save to ",
  "copy to ",
  "add to ",
  "store in ",
];

// True when a candidate string is a password-manager / autofill UI
// affordance rather than a real credential value. Used by the replay
// engine's raw-candidate scan tiers to keep "1Password"-class words
// out of the credential slot.
export function isCredentialNoiseCandidate(candidate: string): boolean {
  const lower = candidate.trim().toLowerCase();
  if (lower.length === 0) return false;
  if (CREDENTIAL_NOISE_TOKENS.includes(lower)) return true;
  return CREDENTIAL_NOISE_PREFIXES.some((p) => lower.startsWith(p));
}
