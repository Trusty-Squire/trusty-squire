// extraction.ts — pure decision primitives of the credential-EXTRACTION phase,
// carved out of extractCredentials (agent.ts:12623) as strangler slice 4 (the A4
// order: nav-search → OAuth/consent → form-fill → EXTRACTION → capture-chain).
// Browser-free + unit-tested.
//
// BOUNDARY (the slice-2/3 lesson — model the decision, executor owns I/O): the
// executor runs the FIVE candidate sources (visible candidates, body text,
// copy-button/clipboard, hidden inputs, copy-button colocation) AND the regex
// classification of each candidate (extractApiKeyFromText + isTruncatedCapture +
// the pass-4 UUID accept). This module decides only the cross-pass POLICY:
//   • accumulation — the first FULL hit wins and ends the scan; a TRUNCATED hit
//     (a masked display like "sk-or-v1-1687…" whose full secret is only on the
//     clipboard) is remembered as a fallback, first-wins, never overriding a full.
//   • resolution — after every pass: a full key → {api_key}; else the truncated
//     stub → {api_key_truncated} (an honest partial beats "no key" when the bot
//     demonstrably reached the modal); else {} (keep navigating).
//
// This is the highest-value, most self-contained pure piece (the truncated-vs-full
// priority is a recurring brittleness source — the S3 masked-key trap). NOT yet
// wired into agent.ts — changing this file cannot regress the live path.

// One candidate's classification, as the executor's regex pass produces it.
export type CandidateClass =
  | { kind: "full"; value: string } // a complete, non-truncated credential
  | { kind: "truncated"; value: string } // key-shaped but a masked/truncated display
  | { kind: "none" }; // not a credential

// Loop-carried extraction state across the passes. `apiKey` is terminal once set
// (the first full hit wins); `truncatedHit` is the first masked stub seen, kept
// only as a last-resort fallback.
export interface ExtractionState {
  apiKey: string | null;
  truncatedHit: string | null;
}

export function initialExtractionState(): ExtractionState {
  return { apiKey: null, truncatedHit: null };
}

// Fold one classified candidate into the state. PURE. First FULL hit wins and is
// sticky (a later candidate cannot override it). A TRUNCATED hit is recorded only
// when no full hit exists yet AND no truncated hit is recorded yet (first-wins),
// mirroring extractCredentials' `truncatedHit = truncatedHit ?? hit`.
export function accumulateCandidate(state: ExtractionState, c: CandidateClass): ExtractionState {
  if (state.apiKey !== null) return state; // already resolved to a full key
  if (c.kind === "full") return { ...state, apiKey: c.value };
  if (c.kind === "truncated") {
    return state.truncatedHit === null ? { ...state, truncatedHit: c.value } : state;
  }
  return state;
}

// Has a terminal full hit been found? The executor stops scanning candidates (and
// skips the remaining passes) once this is true. Pure.
export function hasFullHit(state: ExtractionState): boolean {
  return state.apiKey !== null;
}

// Final resolution after the passes run. PURE. Faithful to extractCredentials'
// tail: a full key → {api_key}; else a truncated stub → {api_key_truncated} (the
// host agent surfaces the partial — better than "no key found" when the modal was
// demonstrably reached); else {} (no credential — the post-verify loop keeps
// navigating to the real keys surface).
export function resolveExtraction(state: ExtractionState): Record<string, string> {
  if (state.apiKey !== null) return { api_key: state.apiKey };
  if (state.truncatedHit !== null) return { api_key_truncated: state.truncatedHit };
  return {};
}
