// Phase 5 — act-target resolution moved out of provision-session.ts (the act
// executor lives in act/act.ts). This module owns the whole target cluster:
// locator targets (`text=`/`css=`), `@e:`-ref resolution against the retained
// element inventory, compact-v2 target authorization, and the prepared-OAuth
// login-target lease. provision-session.ts imports back the names its facade
// still needs and re-exports the public surface, so no caller import changed.
// One-directional imports only: this module must never runtime-import
// provision-session (type-only `Observation`-style imports are fine).
import { AsyncLocalStorage } from "node:async_hooks";
import type { ClickDispatchStatus } from "../click-dispatch.js";
import type { FrameTarget, InteractiveElement } from "../browser.js";
import {
  compactV2LegacyRefForHandle,
  isCompactV2Label,
  type SafeControlV2,
} from "../compact-observation-v2.js";
import { ProvenPreDispatchMutationError } from "../mutation-dispatch-evidence.js";
import {
  compactV2EpochDoc,
  compactV2LiveControls,
  compactV2RefAllocator,
  invalidateCompactV2Snapshot,
} from "../observe/observe.js";
import {
  elementIdentity,
  elementRef,
  norm,
  parseProvisionRef,
  provisionElementRefs,
  volatilePositionalGroups,
} from "../observe/refs.js";
import { sessionForCall } from "../session/lifecycle.js";
import type { Session } from "../session/model.js";

// ── pure helpers (exported for unit tests) ──

// A locator-form target the host supplies when NO `@e:` ref exists for the
// control it needs to act on — for example, a bare click-handler <div> the
// inventory never emitted (no role/label/testid, and past the card-scan cap).
// Two forms:
//   text="Add To Cart"  (quotes optional) — matching clickable/typeable element
//   css=#some-id                          — a raw CSS selector
// Resolved directly across live ordinary page/frame documents by
// BrowserController.resolvePageTarget, NOT against the extracted-element
// inventory (which by definition lacks it).
export type LocatorTarget = { mode: "text" | "css"; value: string };

export function parseLocatorTarget(target: string): LocatorTarget | null {
  const m = /^\s*(text|css)\s*=\s*([\s\S]+)$/i.exec(target);
  if (m === null) return null;
  const mode = (m[1] as string).toLowerCase() === "css" ? "css" : "text";
  let value = (m[2] as string).trim();
  // Strip one matching pair of surrounding quotes so `text="Add To Cart"` and
  // `text=Add To Cart` are equivalent (the quotes only help the host delimit
  // trailing whitespace / punctuation).
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      value = value.slice(1, -1);
    }
  }
  if (value.length === 0) return null;
  return { mode, value };
}

export class AmbiguousProvisionTargetError extends Error {
  readonly code = "ambiguous_target";

  constructor(
    readonly target: string,
    readonly candidates: readonly string[],
  ) {
    super(
      `ambiguous_target: "${target}" matched ${candidates.length} elements. ` +
        `Retry with one exact ref/path: ${candidates.slice(0, 8).join(", ")}`,
    );
  }
}

export interface TargetStaleResult {
  status: "target_stale";
  target: string;
  // The latest completed observation. The next observe increments this value
  // and supplies the authoritative replacement inventory.
  after_generation: number;
  reobserve_required: true;
  // Best-effort semantic hints only. A label can legitimately map to more than
  // one live ref, so callers must still choose from the next observation.
  replacement_candidates: Record<string, string[]>;
  retry_policy: "do_not_retry_old_ref";
}

// An @e: ref is an observation-scoped handle, not a locator. Preserve that
// distinction in the error so an agent does not retry a stale handle or guess a
// text locator after a SPA rerender.
export class TargetStaleError extends Error {
  readonly code = "target_stale";

  constructor(readonly result: TargetStaleResult) {
    super(`target_stale: re-observe before selecting a replacement for "${result.target}"`);
  }
}

export class CompactV2StaleRefError extends Error {}
export class CompactV2UnresolvedLabelError extends Error {}
export class ProvisionTargetNotAllowedError extends Error {}
export class ProvisionTargetMissingError extends Error {}
export class CompactV2ActionFailureError extends Error {
  /** Whether the underlying browser dispatch reached the page, when known. */
  readonly dispatchStatus: ClickDispatchStatus;

  constructor(message: string, dispatchStatus: ClickDispatchStatus = "unknown") {
    super(message);
    this.dispatchStatus = dispatchStatus;
  }
}
/**
 * A `@label` that names more than one observed control. Extends the
 * already-sealed failure channel so its message survives V2's opaque error
 * mapping: it carries ONLY refs the agent already holds, never page text.
 */
class CompactV2AmbiguousLabelError extends CompactV2ActionFailureError {}

function replacementCandidates(elements: readonly InteractiveElement[]): Record<string, string[]> {
  const refs = provisionElementRefs(elements);
  const candidates: Record<string, string[]> = {};
  for (const el of elements) {
    const label = [
      el.labelText,
      el.ariaLabel,
      el.visibleText,
      el.placeholder,
      el.testId,
      el.name,
      el.screenPath,
    ].find(
      (value): value is string => value !== null && value !== undefined && value.trim().length > 0,
    );
    const ref = refs.get(el);
    if (label === undefined || ref === undefined) continue;
    const key = label.replace(/\s+/g, " ").trim();
    if (candidates[key] === undefined) {
      if (Object.keys(candidates).length >= 20) continue;
      candidates[key] = [];
    }
    if (candidates[key]!.length < 4) candidates[key]!.push(ref);
  }
  return candidates;
}

export function staleTargetError(
  session: Session,
  target: string,
  fresh: readonly InteractiveElement[],
): TargetStaleError | null {
  if (parseProvisionRef(target) === null) return null;
  return new TargetStaleError({
    status: "target_stale",
    target,
    after_generation: session.generation,
    reobserve_required: true,
    replacement_candidates: replacementCandidates(fresh),
    retry_policy: "do_not_retry_old_ref",
  });
}

function elementTargetKeys(el: InteractiveElement): string[] {
  return [el.screenPath ?? null, el.testId ?? null, elementRef(el)].flatMap((s) => {
    const v = (s ?? "").replace(/\s+/g, " ").trim();
    return v.length > 0 ? [v] : [];
  });
}

// Shopify defers address geocoding (and therefore delivery-rate loading) until
// its required shipping street field is committed. Keep this deliberately
// narrow: ordinary text fields and even other autocomplete controls retain
// their existing type-only behavior.
export function isRequiredShippingAddressLine1(el: InteractiveElement): boolean {
  if (!el.required) return false;
  const autocomplete = (el.autocomplete ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return autocomplete.includes("shipping") && autocomplete.includes("address-line1");
}

// Resolve a host-supplied target string to one live element. Matching is by
// structured path, test id, or label text, scored exact > startsWith > contains.
// Returns null when nothing matches — the caller surfaces that rather than
// guessing.
export function resolveTarget(
  elements: readonly InteractiveElement[],
  target: string,
): InteractiveElement | null {
  const parsedRef = parseProvisionRef(target);
  if (parsedRef !== null) {
    // Staleness guard: a ref whose identity is absent among the LIVE elements
    // returns null (the caller re-observes). Identity is recomputed here from the
    // live set, so a volatile positional-group ref carries the group's fingerprint
    // at mint time; if the live group has a different fingerprint, the stale ref
    // resolves to null instead of retargeting a survivor (issue #399). This holds
    // WITHIN a turn too: the act path re-extracts, so a membership-count change
    // between observe and act changes the fingerprint and forces a re-observe.
    //
    // Ordinal caveat (same-hash duplicates): the `_<ordinal>` suffix positionally
    // disambiguates elements that hash IDENTICALLY (same selector too — NOT the
    // positional-sibling case, which the fingerprint covers). Mutable state is
    // intentionally absent from that hash, so members need not have identical
    // checked/value/visibility state. If one is removed, an ordinal can resolve to
    // a survivor; the recycled ordinal is not invalidated by `removed`. An ordinal
    // past the current group size still returns null.
    const fingerprintOf = volatilePositionalGroups(elements);
    const matches = elements.filter((el) => elementIdentity(el, fingerprintOf) === parsedRef.id);
    if (parsedRef.ordinal !== null) {
      const match = matches[parsedRef.ordinal - 1];
      return match ?? null;
    }
    if (matches.length === 1) return matches[0] as InteractiveElement;
    if (matches.length > 1) {
      throw new AmbiguousProvisionTargetError(
        target,
        matches.map((el) => `${el.screenPath ?? elementRef(el)} (${elementRef(el)})`),
      );
    }
    return null;
  }

  const want = norm(target);
  if (want.length === 0) return null;
  let best: { el: InteractiveElement; score: number } | null = null;
  let tied: InteractiveElement[] = [];
  for (const el of elements) {
    for (const [i, raw] of elementTargetKeys(el).entries()) {
      const label = norm(raw);
      let score = 0;
      const exact = i === 0 ? 120 : i === 1 ? 110 : 100;
      if (label === want) score = exact;
      else if (label.startsWith(want)) score = 70;
      else if (label.includes(want)) score = 50;
      else if (want.includes(label) && label.length >= 2) score = 30;
      if (score === 0) continue;
      // Prefer shorter labels at equal score (a more specific match).
      const adjusted = score - label.length * 0.01;
      if (best === null || adjusted > best.score) {
        best = { el, score: adjusted };
        tied = [el];
      } else if (Math.abs(adjusted - best.score) < 0.000001) {
        if (!tied.includes(el)) tied.push(el);
      }
    }
  }
  if (best !== null && tied.length > 1) {
    throw new AmbiguousProvisionTargetError(
      target,
      tied.map((el) => `${el.screenPath ?? elementRef(el)} (${elementRef(el)})`),
    );
  }
  return best?.el ?? null;
}

export function throwCompactV2StaleRef(): never {
  // Deliberately opaque: stale V2 errors must not construct V1 replacement
  // candidates or reveal raw labels/legacy identities outside the safe view.
  throw new CompactV2StaleRefError("stale_ref");
}

export interface CompactV2TargetAuthorization {
  legacyRef: string;
  row: SafeControlV2;
}

export interface PreparedOAuthLoginTarget {
  sessionId: string;
  target: string;
  authorization: CompactV2TargetAuthorization;
}

const preparedOAuthLoginTarget = new AsyncLocalStorage<PreparedOAuthLoginTarget>();
export { preparedOAuthLoginTarget };

export function preparePublicOAuthLoginTarget(
  sessionId: string,
  target: string,
): PreparedOAuthLoginTarget | undefined {
  const session = sessionForCall(sessionId);
  if (session?.compactV2Active !== true) return undefined;
  try {
    return {
      sessionId,
      target,
      authorization: compactV2AuthorizationForTarget(session, target),
    };
  } catch (error) {
    if (error instanceof CompactV2StaleRefError) {
      throw new ProvenPreDispatchMutationError("stale_ref", { cause: error });
    }
    throw error;
  }
}

export function withPreparedOAuthLoginTarget<T>(
  prepared: PreparedOAuthLoginTarget,
  operation: () => Promise<T>,
): Promise<T> {
  return preparedOAuthLoginTarget.run(prepared, operation);
}

/**
 * Authorize an agent-supplied target against the observed skeleton. Two forms:
 * a `@e:` handle (the physical node anchor) or a `@label` alias, which resolves
 * to exactly one observed handle or fails — never a guess. Only the epoch's
 * `doc` gates here; a benign re-render since the observation is expected and is
 * settled at act time against live elements.
 */
export function compactV2AuthorizationForTarget(
  session: Session,
  target: string,
  distinguishUnresolvedLabel = false,
): CompactV2TargetAuthorization {
  const index = session.compactV2Index;
  if (index === null) throwCompactV2StaleRef();
  if (index.expiresAt < Date.now() || index.epoch.doc !== compactV2EpochDoc(session)) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2StaleRef();
  }
  const row = isCompactV2Label(target)
    ? resolveCompactV2Label(index.rows, target)
    : index.rows.find((candidate) => candidate.ref === target);
  if (row === undefined) {
    if (
      distinguishUnresolvedLabel &&
      isCompactV2Label(target) &&
      !compactV2RefAllocator(session).hasLabel(target)
    )
      throw new CompactV2UnresolvedLabelError("target_unresolved");
    throwCompactV2StaleRef();
  }
  const legacy = compactV2LegacyRefForHandle(session.compactV2Refs, row.ref);
  if (legacy === null) throwCompactV2StaleRef();
  return { legacyRef: legacy, row };
}

/** A label acts only when it names exactly one observed control. */
function resolveCompactV2Label(
  rows: readonly SafeControlV2[],
  label: string,
): SafeControlV2 | undefined {
  const matches = rows.filter((row) => row.label === label);
  if (matches.length > 1) {
    throw new CompactV2AmbiguousLabelError(
      `ambiguous_target: "${label}" names ${matches.length} controls. ` +
        `Retry with one exact ref: ${matches.map((row) => row.ref).join(", ")}`,
    );
  }
  return matches[0];
}

/**
 * Re-resolve an authorized ref against LIVE elements. The handle is minted from
 * the element's physical node identity under the document epoch, so a ref
 * resolves across a benign re-render (the whole point of the identity model)
 * and fails closed only when that element is genuinely gone or its document
 * epoch changed. Matching is by the durable handle alone — never by the row's
 * role/label/field, which a legitimate re-render may change (and which would
 * otherwise re-run the redundant intent gate this replaced).
 */
export function resolveAuthorizedCompactV2Target(
  session: Session,
  elements: readonly InteractiveElement[],
  authorization: CompactV2TargetAuthorization,
): InteractiveElement {
  const index = session.compactV2Index;
  if (index === null || index.epoch.doc !== compactV2EpochDoc(session)) {
    invalidateCompactV2Snapshot(session);
    throwCompactV2StaleRef();
  }
  const live = compactV2LiveControls(session, elements);
  const matches = live.rows.filter((row) => row.ref === authorization.row.ref);
  // Physical identities are unique within an inventory by construction, so >1
  // means a broken invariant rather than an addressable ambiguity: refuse either way.
  if (matches.length !== 1) throwCompactV2StaleRef();
  const liveRow = matches[0]!;
  const legacy = live.byRef.get(liveRow.ref);
  const resolved = legacy === undefined ? null : resolveTarget(elements, legacy);
  if (resolved === null) throwCompactV2StaleRef();
  return resolved;
}

type FrameScopedTarget = Pick<InteractiveElement, "frameOrigin" | "frameUrl" | "framePath">;

export function frameTargetFor(el: FrameScopedTarget): FrameTarget | null {
  if (el.framePath === undefined || el.framePath === null) return null;
  if (el.frameOrigin === undefined || el.frameOrigin === null) {
    throw new ProvisionTargetNotAllowedError("frame target lacks an origin");
  }
  return {
    framePath: el.framePath,
    frameOrigin: el.frameOrigin,
    frameUrl: el.frameUrl ?? "",
  };
}
