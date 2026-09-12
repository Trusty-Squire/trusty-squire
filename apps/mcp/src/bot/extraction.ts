// extraction.ts — pure decision primitives of the credential-EXTRACTION phase,
// carved out of the credential-extraction phase as strangler slice 4 (the A4
// order: nav-search → OAuth/consent → form-fill → EXTRACTION → capture-chain).
// Browser-free + unit-tested.
//
// BOUNDARY (the slice-2/3 lesson — model the decision, executor owns I/O): the
// executor runs the FIVE candidate sources (visible candidates, body text,
// copy-button/clipboard, hidden inputs, copy-button colocation) AND the regex
// classification of each candidate (extractApiKeyFromText + the pass-4 UUID
// accept). This module decides only the cross-pass POLICY: the first credential
// hit wins and ends the scan; no hit resolves to an empty result.

// One candidate's classification, as the executor's regex pass produces it.
export type CandidateClass = { kind: "full"; value: string } | { kind: "none" }; // not a credential

// Loop-carried extraction state across the passes. `apiKey` is terminal once set
export interface ExtractionState {
  apiKey: string | null;
}

export function initialExtractionState(): ExtractionState {
  return { apiKey: null };
}

// Fold one classified candidate into the state. PURE. First FULL hit wins and is
// sticky (a later candidate cannot override it).
export function accumulateCandidate(state: ExtractionState, c: CandidateClass): ExtractionState {
  if (state.apiKey !== null) return state; // already resolved to a full key
  if (c.kind === "full") return { ...state, apiKey: c.value };
  return state;
}

// Has a terminal full hit been found? The executor stops scanning candidates (and
// skips the remaining passes) once this is true. Pure.
export function hasFullHit(state: ExtractionState): boolean {
  return state.apiKey !== null;
}

// Final resolution after the passes run. PURE.
export function resolveExtraction(state: ExtractionState): Record<string, string> {
  if (state.apiKey !== null) return { api_key: state.apiKey };
  return {};
}
