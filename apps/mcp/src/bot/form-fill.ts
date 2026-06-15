// form-fill.ts — pure decision primitives of the signup FORM-FILL phase, carved
// out of planExecuteWithRetry (strangler slice 3 — see DESIGN-form-fill-engine.md).
// Browser-free + unit-tested. This commit is the no-progress / stuck-loop
// detector (F14 + the page-fingerprint progress check) — the highest-value,
// most self-contained piece and a recurring brittleness source (kinde/Railway
// false-bails). The full decideFormFillStep reducer is the next increment.
//
// Not yet wired into agent.ts — changing this file cannot regress the live path.

// The page "moved" between two form-fill rounds iff the URL changed OR the set of
// interactive selectors changed (a field gained/lost, a validation message
// toggled an element, a wizard step advanced). The fingerprint is url + the
// sorted selector set; ANY change means the previous round made real progress.
export function computePageSig(url: string, selectors: readonly string[]): string {
  return `${url}§${[...selectors].sort().join("|")}`;
}

export function pageMovedSince(prevSig: string | null, currSig: string): boolean {
  return prevSig !== null && currSig !== prevSig;
}

// F14 stuck-loop test: a plan that clicks ONLY selectors already proven dead last
// round (no page progress) — and edits no field — is a planner loop; bail rather
// than re-click forever. Does NOT fire when the plan adds a NEW selector
// (legitimate exploration) or edits a field this round (a fill/check alongside a
// repeated click is real progress — kinde's "tick the required box + re-click
// Next" advances the form even though the Next selector repeats). Pure.
export function isStuckRepeat(input: {
  planClickSelectors: readonly string[];
  planEditsAField: boolean; // any fill/check action this round
  noProgressSelectors: ReadonlySet<string>; // selectors that didn't advance last round
}): boolean {
  if (input.planEditsAField) return false;
  if (input.planClickSelectors.length === 0) return false;
  if (input.noProgressSelectors.size === 0) return false;
  return input.planClickSelectors.every((s) => input.noProgressSelectors.has(s));
}

// The dead-selector memory update after a NO-PROGRESS round (the page only
// revealed/advanced, no fillable form yet): a field edit this round means real
// progress → clear the set; otherwise record THIS round's click selectors so the
// next round's isStuckRepeat can catch a loop. Pure (returns a fresh set).
export function nextNoProgressSet(input: {
  planClickSelectors: readonly string[];
  hadFieldEdit: boolean;
}): Set<string> {
  return input.hadFieldEdit ? new Set() : new Set(input.planClickSelectors);
}
