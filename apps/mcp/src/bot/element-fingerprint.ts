import type { InteractiveElement } from "./browser.js";

// Element identity for the operator observation model (docs/observation-model.md
// §4.1). An element's fingerprint is DURABLE: it is derived only from signals
// that survive a benign re-render, so a ref the host already holds keeps
// resolving while the agent fills the rest of a form. Mutable state (value,
// checked, occlusion) and the observation counter are deliberately excluded.
//
// Two inputs, in order:
//   1. The DOM `id`, when it is present, unique on the page, and not
//      framework-random. An authored id is the most stable handle a page
//      offers and survives arbitrary subtree churn.
//   2. Otherwise a structural signal: accessibility path + role + normalized
//      accessible name + the ordinal among otherwise-identical siblings.
//
// Both branches are frame-scoped. Without that, a same-shaped control in an
// embedded frame could hash to the SAME fingerprint as one in the main page and
// let an act resolve into the wrong document — the frame domain-lock
// (assertSecretFrameTargetAllowed) must not be the only thing standing between
// a secret and a rogue iframe.

/** Unit separator: never present in a DOM id, name, role, or path. */
const SEP = "\u001f";

// Framework-generated ids are unique per RENDER, which is worse than useless:
// keying on one produces a ref that dies on the next paint. React's `useId`
// emits `:r3:` / `:R1abc:`; Radix, HeadlessUI and Reach wrap the same sigil;
// MUI/Ember/Emotion append a render-scoped counter.
const FRAMEWORK_RANDOM_ID_PATTERNS: readonly RegExp[] = [
  // React useId and every library that embeds it. The `:` sigil cannot appear
  // in an id an author intends to use with `#id` CSS, so it is a reliable tell.
  /:/,
  // A UUID or a long digit run: generated, never authored.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /\d{5,}/,
  // `mui-4821`, `ember1234`, `downshift-3-item-0`, `css-1x9dk2p`.
  /^(?:mui|ember|downshift|react-aria|radix|headlessui|reach|css|sc)-?\d/i,
];

export function isFrameworkRandomDomId(id: string): boolean {
  const trimmed = id.trim();
  if (trimmed.length === 0) return true;
  return FRAMEWORK_RANDOM_ID_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The accessible name, from the same visible/ARIA sources the label uses. */
function accessibleName(el: InteractiveElement): string {
  return normalize(
    el.visibleText ??
      el.labelText ??
      el.ariaLabel ??
      el.iconLabel ??
      el.title ??
      el.placeholder ??
      el.name,
  );
}

function frameKey(el: InteractiveElement): string {
  return [el.frameOrigin ?? "", el.framePath ?? ""].join(SEP);
}

function roleKey(el: InteractiveElement): string {
  return [normalize(el.role), normalize(el.tag), normalize(el.type)].join(SEP);
}

function usableDomId(el: InteractiveElement, idCounts: ReadonlyMap<string, number>): string | null {
  const id = (el.id ?? "").trim();
  if (id.length === 0 || isFrameworkRandomDomId(id)) return null;
  return idCounts.get([frameKey(el), id].join(SEP)) === 1 ? id : null;
}

/**
 * The durable fingerprint of every element in one inventory. Pure, and
 * order-dependent only through the sibling ordinal — which by construction
 * applies solely to elements that are otherwise indistinguishable.
 */
export function elementFingerprints(
  elements: readonly InteractiveElement[],
): Map<InteractiveElement, string> {
  const idCounts = new Map<string, number>();
  for (const el of elements) {
    const id = (el.id ?? "").trim();
    if (id.length === 0 || isFrameworkRandomDomId(id)) continue;
    const key = [frameKey(el), id].join(SEP);
    idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  const fingerprints = new Map<InteractiveElement, string>();
  for (const el of elements) {
    const domId = usableDomId(el, idCounts);
    if (domId !== null) {
      fingerprints.set(el, ["id", frameKey(el), domId].join(SEP));
      continue;
    }
    // The accessibility path the DOM inventory captured (`screenPath`, e.g.
    // "dialog:finish-account > button:create-account"), falling back to the
    // nearest named container.
    const structural = [
      frameKey(el),
      normalize(el.screenPath ?? el.container),
      roleKey(el),
      accessibleName(el),
    ].join(SEP);
    const ordinal = (ordinals.get(structural) ?? 0) + 1;
    ordinals.set(structural, ordinal);
    fingerprints.set(el, ["path", structural, String(ordinal)].join(SEP));
  }
  return fingerprints;
}
