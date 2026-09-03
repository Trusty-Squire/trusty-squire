import type { InteractiveElement } from "./browser.js";

// Element identity for the operator observation model (docs/observation-model.md
// §4.1). An element's fingerprint is DURABLE: it is derived only from signals
// that survive a benign re-render, so a ref the host already holds keeps
// resolving while the agent fills the rest of a form. Mutable state (value,
// checked, occlusion) and the observation counter are deliberately excluded.
//
// Inputs, in strict preference order — each tier is consulted only when the one
// above it does not identify the element uniquely within the inventory:
//   1. The DOM `id`, when it is present, unique on the page, and not
//      framework-random. An authored id is the most stable handle a page
//      offers and survives arbitrary subtree churn.
//   2. The stable semantic signals: frame + role/tag/type + accessible name +
//      the authored form-control `name`. None of those move when a live form
//      re-renders, so a field whose label is unique in its frame keeps one
//      fingerprint across arbitrary sibling churn.
//   3. The containing region, as a disambiguator for same-named controls that
//      live in different parts of the page ("Continue" in a dialog vs. in the
//      page form).
//   4. The ordinal among elements that tiers 1-3 leave genuinely
//      indistinguishable — a LAST resort, and the only positional input.
//
// The accessibility path (`screenPath`) is deliberately NOT an input. It is
// built as `<container> > <kind>:<label-or-positional-slug>`: its container is
// already tier 3, its kind and label are already tier 2, and its fallback slug
// embeds the element's index in the inventory. A Shopify-style address block
// that reorders its fields when Places autocomplete re-renders would otherwise
// change every fingerprint in the block and fail closed on every fill.
//
// Every tier is frame-scoped. Without that, a same-shaped control in an
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

/**
 * The authored form-control `name`. It is submitted with the form, so a page
 * cannot regenerate it per render the way it can a `useId` DOM id, and it keeps
 * `firstName` distinct from `lastName` even in the instant a floating label is
 * detached mid-re-render.
 */
function controlName(el: InteractiveElement): string {
  const name = (el.name ?? "").trim();
  return name.length === 0 || isFrameworkRandomDomId(name) ? "" : normalize(name);
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

/** The tier-2 and tier-3 keys for one element (see the header). */
function structuralKeys(el: InteractiveElement): { semantic: string; regional: string } {
  const semantic = [frameKey(el), roleKey(el), accessibleName(el), controlName(el)].join(SEP);
  return { semantic, regional: [semantic, normalize(el.container)].join(SEP) };
}

/**
 * The durable fingerprint of every element in one inventory. Pure, and
 * order-dependent only through the last-resort ordinal — which by construction
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
  // Count first, assign second: a tier identifies an element only when it is
  // unambiguous across the WHOLE inventory, which is not knowable while still
  // walking it.
  const structural = new Map<InteractiveElement, { semantic: string; regional: string }>();
  const semanticCounts = new Map<string, number>();
  const regionalCounts = new Map<string, number>();
  for (const el of elements) {
    if (usableDomId(el, idCounts) !== null) continue;
    const keys = structuralKeys(el);
    structural.set(el, keys);
    semanticCounts.set(keys.semantic, (semanticCounts.get(keys.semantic) ?? 0) + 1);
    regionalCounts.set(keys.regional, (regionalCounts.get(keys.regional) ?? 0) + 1);
  }
  const ordinals = new Map<string, number>();
  const fingerprints = new Map<InteractiveElement, string>();
  for (const el of elements) {
    const domId = usableDomId(el, idCounts);
    if (domId !== null) {
      fingerprints.set(el, ["id", frameKey(el), domId].join(SEP));
      continue;
    }
    const keys = structural.get(el)!;
    if (semanticCounts.get(keys.semantic) === 1) {
      fingerprints.set(el, ["name", keys.semantic].join(SEP));
      continue;
    }
    if (regionalCounts.get(keys.regional) === 1) {
      fingerprints.set(el, ["region", keys.regional].join(SEP));
      continue;
    }
    const ordinal = (ordinals.get(keys.regional) ?? 0) + 1;
    ordinals.set(keys.regional, ordinal);
    fingerprints.set(el, ["ordinal", keys.regional, String(ordinal)].join(SEP));
  }
  return fingerprints;
}
