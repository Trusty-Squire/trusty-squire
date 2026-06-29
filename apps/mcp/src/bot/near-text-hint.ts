// near-text-hint.ts — shared disambiguator for ambiguous inventory
// matches. Used by the synthesizer (promote-to-skill.ts) when it picks a
// near_text_hint to emit, and by recipe replay (operate_use) when it
// applies one.
//
// Kept as its own module so the synthesizer can validate its chosen
// near_text_hint via the same scoring logic that runs at replay time.
// Without this, a chosen hint that looked plausible in the local
// inventory window could fail to disambiguate at replay (or pick the
// wrong duplicate).

import type { InteractiveElement } from "./browser.js";

export function filterByNearTextHint(
  matches: readonly InteractiveElement[],
  hint: string | undefined,
  inventory: readonly InteractiveElement[],
): InteractiveElement[] {
  if (hint === undefined || hint.length === 0) return [...matches];
  const lower = hint.toLowerCase();

  type Scored = {
    el: InteractiveElement;
    bestPreceding: number;
    bestFollowing: number;
  };
  const scored: Scored[] = matches.map((el) => {
    const elIdx = inventory.findIndex((x) => x.selector === el.selector);
    let bestPreceding = Number.POSITIVE_INFINITY;
    let bestFollowing = Number.POSITIVE_INFINITY;
    if (elIdx !== -1) {
      for (let i = 0; i < inventory.length; i++) {
        const text = (
          inventory[i]!.visibleText ?? inventory[i]!.ariaLabel ?? ""
        ).toLowerCase();
        if (!text.includes(lower)) continue;
        const d = elIdx - i;
        if (d > 0 && d < bestPreceding) bestPreceding = d;
        if (d < 0 && -d < bestFollowing) bestFollowing = -d;
      }
    }
    return { el, bestPreceding, bestFollowing };
  });

  if (
    scored.every(
      (s) =>
        !Number.isFinite(s.bestPreceding) && !Number.isFinite(s.bestFollowing),
    )
  ) {
    return [];
  }

  let minPreceding = Number.POSITIVE_INFINITY;
  for (const s of scored)
    if (s.bestPreceding < minPreceding) minPreceding = s.bestPreceding;
  if (Number.isFinite(minPreceding)) {
    const winners = scored.filter((s) => s.bestPreceding === minPreceding);
    if (winners.length === 1) return [winners[0]!.el];
  }

  let minFollowing = Number.POSITIVE_INFINITY;
  for (const s of scored)
    if (s.bestFollowing < minFollowing) minFollowing = s.bestFollowing;
  if (Number.isFinite(minFollowing)) {
    const winners = scored.filter((s) => s.bestFollowing === minFollowing);
    if (winners.length === 1) return [winners[0]!.el];
  }

  const windowFiltered = matches.filter((el) =>
    nearTextHintMatches(el, hint, inventory),
  );
  return windowFiltered.length > 0 ? windowFiltered : [...matches];
}

export function nearTextHintMatches(
  el: InteractiveElement,
  hint: string,
  inventory: readonly InteractiveElement[],
): boolean {
  const idx = inventory.findIndex((e) => e.selector === el.selector);
  if (idx === -1) return false;
  const lowerHint = hint.toLowerCase();
  const start = Math.max(0, idx - 5);
  const end = Math.min(inventory.length, idx + 6);
  for (let i = start; i < end; i++) {
    const t = (inventory[i]!.visibleText ?? inventory[i]!.ariaLabel ?? "")
      .toLowerCase();
    if (t.includes(lowerHint)) return true;
  }
  return false;
}
