// credential-shape.ts — browser-free, unit-tested predicates for "is this
// string a masked display / an OTP / credential-shaped". None of them decides
// whether a value is stored: that policy is owned by
// docs/operator-tool-surface.md#credential-capture-and-retrieval.
// browser.ts keeps an inline copy of
// MASKED_DISPLAY_RE's source because `page.evaluate` code can't import — keep
// the two in sync.

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

const OTP_KEYWORD_RE =
  /(?:code|verification|verify|otp|passcode|one[- ]time)\D{0,40}?(\d{4,8})|(\d{4,8})\D{0,8}?(?:code|verification|verify|otp|passcode)/i;

export function findOtpCredential(value: string): string | null {
  const match = OTP_KEYWORD_RE.exec(value);
  return match?.[1] ?? match?.[2] ?? null;
}

export function isStandaloneOtpCredential(value: string): boolean {
  return /^\d{4,8}$/.test(value.trim());
}

export const CRED_TOKEN_RE =
  /\b([A-Fa-f0-9]{64})\b|\b[A-Za-z][A-Za-z0-9]{1,9}[_-][A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g;
export function findCredentialTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CRED_TOKEN_RE)) {
    const t = m[0];
    // A scanner can match the visible prefix of a masked display and stop
    // immediately before its ellipsis. That prefix is not a readable key.
    if (isMaskedDisplay(text.slice((m.index ?? 0) + t.length, (m.index ?? 0) + t.length + 4)))
      continue;
    if (seen.has(t)) continue;
    if (m[1] === undefined) {
      if (t.length < 16) continue;
      if (!/[0-9]/.test(t)) continue;
      if (/^[A-Z][A-Z0-9_]*$/.test(t)) continue;
      if (!looksLikeCredentialToken(t)) continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function looksLikeCredentialToken(token: string): boolean {
  if (/^[A-Fa-f0-9]{64}$/.test(token)) return true;
  if (token.includes("_")) return true;
  if (/^(?:api|key|pk|re|rk|sk|xai|ghp|pat|vsk|tly)-/i.test(token)) return true;
  // <short alpha vendor prefix>-<single long alphanumeric run>: tly-xkVZ…
  if (/^[A-Za-z][A-Za-z0-9]{0,7}-[A-Za-z0-9]{12,}$/.test(token)) return true;
  // Multi-segment vendor key (Luma's luma-api-4Y7FDyM…): accept when SOME segment
  // is a high-entropy run — ≥10 chars carrying BOTH a letter and a digit. That
  // separates a real key from a word-word-word-date slug
  // (trusty-squire-dogfood-20260625), whose segments are dictionary words or a
  // pure-digit date — neither is a long letter+digit run.
  return token.split("-").some((s) => s.length >= 10 && /[A-Za-z]/.test(s) && /[0-9]/.test(s));
}

// These scanners must not screen observation or screenshot output. The read
// boundary, including the separate released-card value mask, is owned by
// docs/observation-model.md §4.5; credential capture is owned by
// docs/operator-tool-surface.md#credential-capture-and-retrieval.
