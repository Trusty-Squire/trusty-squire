// Pure element-ref identity, extracted from provision-session.ts (layer-contracts
// PR 9). An `@e:` ref is minted by the observation inventory and resolved by the
// act path, so both sides import from here; the module depends on nothing but
// the element shape. No behaviour change — every function moved verbatim.

import { createHash } from "node:crypto";
import type { InteractiveElement } from "../browser.js";

export const norm = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

// Element ref = a STABLE-by-default handle: "@e:<identity>_<ordinal>". For a
// normal control `<identity>` is its generation-independent stableElementId, so
// the per-session observe delta can leave an unchanged element un-re-emitted and
// the ref the host already holds keeps resolving. The `@e:` sigil only
// disambiguates a ref from a free-text label target (a label may legitimately end
// in "_<digits>"). Staleness is guarded by IDENTITY, not a counter: a ref whose
// element is now gone finds no match in resolveTarget → returns null → the public
// tool returns structured target_stale guidance and the host re-observes.
//
// The exceptional identity form (issue #399) applies to same-base-identity
// siblings distinguished ONLY by positional selectors. Those "volatile" members
// get an identity prefixed with their sibling group's composition FINGERPRINT
// ("<fp>-<hash>", see volatilePositionalGroups + elementIdentity), so a ref is
// valid only while that fingerprint matches. A membership-count change re-mints
// the group and makes every old ref resolve to null, never to a survivor.
// Size-preserving changes among truly indistinguishable members are the bounded
// residual documented at volatilePositionalGroups. `<fp>-` stays within the id
// charset below, so no parsing changes are needed.
const PROVISION_REF_RE = /^@e:([a-z0-9_-]+)$/i;
const PROVISION_REF_ID_RE = /^(.+)_(\d+)$/;

// The label a host sees + targets by. Prefer the most human, stable signal.
export function elementRef(el: InteractiveElement): string {
  const cand =
    el.visibleText ??
    el.labelText ??
    el.ariaLabel ??
    el.iconLabel ??
    el.placeholder ??
    el.title ??
    el.name ??
    (typeof el.value === "string" && el.value.length > 0 ? el.value : null);
  const label = (cand ?? "").replace(/\s+/g, " ").trim();
  return label.length > 0 ? label.slice(0, 80) : `${el.tag}#${el.index}`;
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("base64url").slice(0, 12);
}

function baseIdentityFields(el: InteractiveElement): string[] {
  return [
    el.screenPath ?? "",
    el.testId ?? "",
    el.container ?? "",
    el.role ?? "",
    el.tag,
    elementRef({ ...el, value: null }),
    el.href ?? "",
    el.type ?? "",
    // Frame origin + full frame URL — WITHOUT these, an element's `selector`
    // (folded into stableElementId below) is only unique within its own
    // document, so a same-shaped selector in two different frames (or a frame
    // vs. the main page) could hash to the SAME ref and let an act resolve to
    // the wrong frame's element. Load-bearing for frame identity: the ref
    // itself must be frame-scoped, not just the guard that later reads it.
    //
    // The frame's URL, NOT its positional framePath, is the durable frame
    // component: hosted-field providers (Braintree, PayPal, Stripe Elements)
    // remount their <iframe> after the first input, and Playwright then
    // APPENDS the replacement to the parent's childFrames() list, shifting
    // every positional path. A framePath-keyed identity would re-mint every
    // framed ref on that remount and turn later inject_card fields into
    // not_found; the remount keeps the iframe's src, so the URL survives.
    el.frameOrigin ?? "",
    el.frameUrl ?? "",
  ];
}

export function stableElementId(el: InteractiveElement): string {
  return shortHash(
    [
      ...baseIdentityFields(el),
      // The element's own selector — a per-element discriminator so two controls
      // that are otherwise identical (same label/path/role, e.g. sibling "Remove"
      // buttons in a list) get DISTINCT identities. Without it, a stable ref is a
      // positional ordinal within a same-hash group: remove the first sibling and
      // the old `_1` silently retargets the survivor. With a STABLE selector
      // (id/data-attr) folded in, the removed element's identity is unique, so its
      // old ref finds no match and resolveTarget returns null (the host
      // re-observes) — no mis-click.
      //
      // Mutable state (`checked`, value length, topmost/occlusion) is deliberately
      // excluded so fills, toggles, and visibility changes keep the same ref.
      // A purely POSITIONAL selector (`:nth-of-type`/`:nth-child`/`>> nth=`)
      // recycles on sibling removal, so this hash alone would let a survivor
      // slide onto a departed node's identity. Closed one layer up (issue #399):
      // volatilePositionalGroups fingerprints such sibling groups and
      // elementIdentity prefixes their refs with that fingerprint, so a group
      // size change makes every old positional ref resolve to null.
      el.selector,
    ].join("\u001f"),
  );
}

// The base identity WITHOUT the selector — the grouping key for same-label
// sibling detection.
function baseElementKey(el: InteractiveElement): string {
  return baseIdentityFields(el).join("\u001f");
}

// A selector that pins an element only by its POSITION among siblings
// (`:nth-of-type`/`:nth-child`, or Playwright's `>> nth=` index). Such selectors
// RECYCLE: remove an earlier sibling and a later one slides into the vacated
// position, so the identical selector string then designates a DIFFERENT node.
// Stable anchors (#id, [data-testid], [name=…]) never recycle this way. Quoted
// attribute VALUES (incl. backslash-escaped quotes) are blanked first so a stable
// `[data-key="x:nth-child(1)"]` — the value merely CONTAINS the syntax — is not
// misread as a positional combinator; only real structural syntax counts.
const POSITIONAL_SELECTOR_RE = /:nth-of-type\(|:nth-child\(|>>\s*nth=/i;
const QUOTED_VALUE_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
function isPositionalSelector(selector: string): boolean {
  return POSITIONAL_SELECTOR_RE.test(selector.replace(QUOTED_VALUE_RE, '""'));
}

// A "volatile positional group": the ≥2 POSITIONAL members of a same-base-identity
// group (any stable-anchored siblings in the same base group keep their plain,
// non-volatile refs). Removing one shifts a survivor's positional selector onto a
// departed node's identity, so a purely structural ref would silently retarget
// the survivor (issue #399). Returns each such member mapped to a GROUP
// FINGERPRINT — a hash of the positional members' stableElementIds in extraction
// order. elementIdentity prefixes the member's ref with that fingerprint, so the
// ref is valid ONLY while the positional membership matches.
//
// Guarantees (the #399 invariant): after a member is REMOVED (group size N→N-1),
// the fingerprint changes, so the departed member's old ref appears in `removed`
// (or a full resync) and resolves to null — never a survivor — including WITHIN a
// turn (the act path re-extracts, so a mid-turn removal changes the fingerprint
// and forces a re-observe rather than mis-targeting a shifted sibling). Because
// the identity is composition-derived (not an observe counter), a static group's
// refs stay stable across observes (no wasted churn) and a toggled checkbox /
// filled field keeps its ref (mutable state is excluded from stableElementId).
//
// Bounded residual: the fingerprint is built from the members' own
// position-derived hashes, so a SIZE-PRESERVING shuffle of TRULY INDISTINGUISHABLE
// members — delete-one-and-insert-one, or a pure reorder, where the members carry
// ZERO distinguishing signal (identical label/aria/testid/text/screenPath, only
// the nth differs) — leaves the fingerprint unchanged and is not detected. This
// is information-theoretically unavoidable for a string-derived identity: such an
// observation is byte-identical to "nothing changed," so no ref scheme can flag
// it. Real per-row controls carry a distinguishing signal (row text / aria-label
// / a data-id), which lands them in DISTINCT base groups (non-volatile) where the
// #398 stable-selector identity already guards them. Fully closing the residual
// needs an extractor-stamped per-node id that survives DOM mutation — deferred
// because stamping every interactive node with a persistent attribute is
// anti-bot-detectable (a worse regression than the residual it removes).
export function volatilePositionalGroups(
  elements: readonly InteractiveElement[],
): Map<InteractiveElement, string> {
  const groups = new Map<string, InteractiveElement[]>();
  for (const el of elements) {
    const key = baseElementKey(el);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [el]);
    else group.push(el);
  }
  const fingerprintOf = new Map<InteractiveElement, string>();
  for (const group of groups.values()) {
    // ≥2 positional siblings sharing a base identity can recycle onto EACH
    // OTHER; a lone positional member (or any stable-anchored member) cannot.
    const positional = group.filter((el) => isPositionalSelector(el.selector));
    if (positional.length < 2) continue;
    // Extraction-order fingerprint: sensitive to membership-count and selector-
    // sequence changes, subject to the size-preserving residual above.
    const fp = shortHash(positional.map((el) => stableElementId(el)).join(""));
    for (const el of positional) fingerprintOf.set(el, fp);
  }
  return fingerprintOf;
}

// The ref identity of one element. A volatile positional-group member is
// prefixed with its group fingerprint (`<fp>-<hash>`) so its ref survives only
// while the group's composition is unchanged; everything else uses its plain,
// composition-independent stableElementId (byte-identical to the pre-#399 ref).
export function elementIdentity(
  el: InteractiveElement,
  fingerprintOf: ReadonlyMap<InteractiveElement, string>,
): string {
  const base = stableElementId(el);
  const fp = fingerprintOf.get(el);
  return fp === undefined ? base : `${fp}-${base}`;
}

export function parseProvisionRef(target: string): { id: string; ordinal: number | null } | null {
  const m = target.trim().match(PROVISION_REF_RE);
  if (m === null) return null;
  const rawId = m[1] as string;
  const idMatch = rawId.match(PROVISION_REF_ID_RE);
  return {
    id: idMatch !== null ? (idMatch[1] as string) : rawId,
    ordinal: idMatch !== null ? Number.parseInt(idMatch[2] as string, 10) : null,
  };
}

export function provisionElementRefs(
  elements: readonly InteractiveElement[],
): Map<InteractiveElement, string> {
  const fingerprintOf = volatilePositionalGroups(elements);
  const seen = new Map<string, number>();
  const refs = new Map<InteractiveElement, string>();
  for (const el of elements) {
    const id = elementIdentity(el, fingerprintOf);
    const ordinal = (seen.get(id) ?? 0) + 1;
    seen.set(id, ordinal);
    refs.set(el, `@e:${id}_${ordinal}`);
  }
  return refs;
}
