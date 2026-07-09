// credential-shape.ts — the canonical, browser-free, unit-tested predicates for
// "is this string a masked display / noise / a credential value". Carved out of
// provision-session.ts so the host-side judgments live in ONE place instead of
// drifting across provision-session, provision-drive, and the op-driver harness.
//
// TIERS — deliberately NOT merged: browser.ts's in-page `isCredentialShape` is a
// LOOSE candidate collector (length ≥6, collect broadly, refine by proximity);
// the predicates here are the TIGHT final gate (length ≥12, token/JWT/UUID).
// Those are two correct tiers, not drift. The ONE thing genuinely shared is the
// masked-glyph definition: browser.ts keeps an inline copy of MASKED_DISPLAY_RE's
// source because `page.evaluate` code can't import — keep the two in sync.

// One canonical masked-display test — the union of the four spellings that had
// drifted across the codebase (browser.ts `[•●⬤]{3,}|\*{4,}`, provision-session's
// `…|...`, the driver's `•|***|\.{3,}`). A masked credential display shows mask
// glyphs where the value should be; treat ANY of them as masked. This is the
// masked-key trap (Zilliz/S3): UNDER-detecting a mask leaks a `••••`/`sk-…` stub
// as a false key, while OVER-detecting merely defers to a reveal pass — safe. So
// the canonical errs permissive (any single mask glyph counts).
export const MASKED_DISPLAY_RE = /[•●⬤]|\*{3,}|…|\.{3,}/;
export function isMaskedDisplay(value: string): boolean {
  return MASKED_DISPLAY_RE.test(value);
}

// A real credential never looks like a code identifier. X's anti-bot tombstone
// ("JavaScript is not available…") leaked `loader.tweetUnavailableTombstoneHandler`
// (a JS function name) into the extractor, which wrote it to the vault as a key
// — a false-green. Reject any dotted member-access token (JWTs are the one
// legitimate dotted credential, guarded by their `eyJ` prefix).
export function looksLikeCodeIdentifier(s: string): boolean {
  const t = s.trim();
  if (t.startsWith("eyJ")) return false;
  return /[A-Za-z]\.[A-Za-z]/.test(t);
}

export function isCredentialNoise(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  // Whitespace anywhere → page prose, not a key (a greeting like "Hi X, what do
  // you want to make?", a sentence, "Owner: foo"). Real keys never contain spaces.
  if (/\s/.test(v)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return true;
  if (/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v)) return true; // ISO date/timestamp (2026-06-23)
  if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return true; // email address
  if (v.endsWith(":")) return true; // a UI label fragment ("Owner:")
  if (/^v?\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^trusty-squire-dogfood-\d{8}$/i.test(v)) return true;
  // Env-var NAME (API_KEY, DATABASE_URL) — but bounded: real names are short. An
  // 80-char all-uppercase string is a prefixless KEY (ScrapingBee), not an env
  // var, and must reach the credential gate. Cap at 39 chars (key gate needs ≥40).
  if (/^[A-Z][A-Z0-9_]{2,38}=?$/.test(v)) return true;
  if (/^key_[A-Za-z0-9]{16,}$/i.test(v)) return true;
  // A masked/truncated display is not a real value (canonical glyph test — was
  // `includes("…")||includes("...")` here, now unified so a `••••`/`****` mask is
  // caught too).
  if (isMaskedDisplay(v)) return true;
  return false;
}

// Collect every distinct credential-SHAPED token in a blob of page text:
// a short prefix + separator + a long body that carries at least one digit
// (vsk_sandbox_write_…, xai-…, sk-lw-…, re_…). Used to surface the SECOND key a
// multi-credential service shows (e.g. VouchFlow's sandbox read alongside write)
// that the single-key extraction policy stops short of. The `[_-]` and has-digit
// requirements exclude the dotted-function-name false positive.
export const CRED_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]{1,9}[_-][A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g;
export function findCredentialTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CRED_TOKEN_RE)) {
    const t = m[0];
    if (seen.has(t)) continue;
    if (t.length < 16) continue;
    if (!/[0-9]/.test(t)) continue; // real keys carry digits; dictionary words don't
    if (/^[A-Z][A-Z0-9_]*$/.test(t)) continue; // env-var name
    if (!looksLikeCredentialToken(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function looksLikeCredentialToken(token: string): boolean {
  if (token.includes("_")) return true;
  if (/^(?:api|key|pk|re|rk|sk|xai|ghp|pat|vsk|tly)-/i.test(token)) return true;
  // <short alpha vendor prefix>-<single long alphanumeric run>: tly-xkVZ…
  if (/^[A-Za-z][A-Za-z0-9]{0,7}-[A-Za-z0-9]{12,}$/.test(token)) return true;
  // Multi-segment vendor key (Luma's luma-api-4Y7FDyM…): accept when SOME segment
  // is a high-entropy run — ≥10 chars carrying BOTH a letter and a digit. That
  // separates a real key from a word-word-word-date slug
  // (trusty-squire-dogfood-20260625), whose segments are dictionary words or a
  // pure-digit date — neither is a long letter+digit run.
  return token
    .split("-")
    .some((s) => s.length >= 10 && /[A-Za-z]/.test(s) && /[0-9]/.test(s));
}

// The vendor FAMILY of a key = the leading letters before its first separator.
// (re_… → "re", vsk_sandbox_write_… → "vsk", xai-… → "xai".) A genuine SECOND
// credential from the same service repeats this family — VouchFlow shows a vsk_
// write key AND a vsk_ read key. A token of a DIFFERENT family that merely sits
// on the same dashboard (a Resend page's mcp-… widget token beside the real re_
// key) does NOT, and must not be surfaced as api_key_2 (capture bug 2026-07-09).
// Returns null for a prefixless / separatorless key.
export function keyFamilyPrefix(token: string): string | null {
  const m = /^([A-Za-z]{2,})[_-]/.exec(token.trim());
  return m !== null ? m[1]!.toLowerCase() : null;
}

// Last-resort acceptance for a PREFIXLESS, SEPARATORLESS key — the shape the
// strict scanners (extractApiKeyFromText, findCredentialTokens) deliberately
// refuse from raw page text, because a bare 32-char base62 string is
// indistinguishable from a content hash / nonce / trace id. The ONE thing that
// disambiguates it is CONTEXT: this token was harvested from directly beside a
// copy/reveal affordance (browser.extractCredentialsNearCopyButtons), and
// dashboards put the copy button next to the SECRET, not next to a trace id.
// deepinfra's keys table (`Hb1bT6VZJdM2cvxVKdm2WCL3kdg6VNNz` in a row with a
// copy + a reveal control) is the canonical case the prefix-based extractor
// can't see. Apply ONLY to copy-proximate tokens, NEVER to raw page text.
export function pickRelaxedNearCopyCredential(nearCopyTokens: readonly string[]): string | null {
  for (const raw of nearCopyTokens) {
    const t = raw.trim();
    // Real keys are long; bound out short UI tokens and runaway page blobs.
    if (t.length < 20 || t.length > 128) continue;
    // Key charset only — rejects dates (06/29/2026), times (12:30:38), emails,
    // URLs, and any token that picked up punctuation/prose.
    if (!/^[A-Za-z0-9_\-.]+$/.test(t)) continue;
    // Entropy: a real key carries BOTH letters and digits.
    if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) continue;
    if (isCredentialNoise(t)) continue; // dates/emails/versions/env-var-names/masked
    if (looksLikeCodeIdentifier(t)) continue; // dotted member access
    // A bare UUID is ambiguous (project/request/trace ids litter dashboards) —
    // refuse it even near a copy button.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) continue;
    // A long hex-only run is more likely a sha/etag/commit than a key, and any
    // real hex key worth storing carries a prefix the strict path already
    // matches — so require entropy BEYOND hex (a g-z / G-Z letter).
    if (/^[0-9a-f]+$/i.test(t)) continue;
    return t;
  }
  return null;
}

// The TIGHT host-side gate: is this string a credential VALUE we'd surface/store?
// (Distinct from browser.ts's loose in-page collector — see the TIERS note above.)
export function looksLikeCredentialValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 12) return false;
  if (looksLikeCodeIdentifier(v)) return false;
  if (isCredentialNoise(v)) return false;
  return (
    findCredentialTokens(v).includes(v) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ||
    // A long, PREFIXLESS all-uppercase alphanumeric key (ScrapingBee: 80-char
    // A-Z0-9, no separator) — the strict token scanners need a prefix/separator
    // and missed it. Pure-uppercase ≥40 with BOTH letters and digits is a
    // deliberate key shape, distinct from lowercase-hex hashes and mixed-case
    // session tokens. MEASURED 2026-07-01 (ScrapingBee dashboard key).
    (/^[A-Z0-9]{40,}$/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v))
  );
}
