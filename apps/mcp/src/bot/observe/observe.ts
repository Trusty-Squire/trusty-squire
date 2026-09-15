// Observation-side code, extracted verbatim from provision-session.ts
// (layer-contracts PR 9 — the observe module split). Owns the operate_observe
// pipeline: compact-V2 snapshot shaping, paging cursors, per-session source-page
// bookkeeping, ref minting (see ./refs.ts), and the session-facing
// observeSession. No behaviour change. provision-session imports the
// session-facing entry points back from here; this module never imports
// provision-session at runtime (the `Observation` shape is a type-only import).

import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import type { InteractiveElement } from "../browser.js";
import type { BrowserUseCapture } from "../browser-use-capture.js";
import { serializeBrowserUseDOM } from "../browser-use-serializer.js";
import {
  StableObservationRefs,
  buildSafeControlsV2,
  compactV2DegradeMetadata,
  controlQueryMatchV2,
  encodeV2QueryPage,
  safeBlockersV2,
  safePageSemanticsV2,
  BLOCKER_MAX_ITEMS,
  safeStageV2,
  type ObservationEpochV2,
  type ObservationSemanticSourceV2,
  type SafeControlV2,
  type SafeObservationIndexV2,
  type SafePageSemanticsV2,
  type SafeStageV2,
  wireRoleToSafeRoleV2,
} from "../compact-observation-v2.js";
import {
  completeOAuthTransitionRecovery,
  oauthTransitionStatus,
  refreshOAuthHumanChallenge,
  type OAuthCompletionEvidence,
} from "../oauth-login.js";
import type { Session } from "../session/model.js";
import { retainSessionElements } from "../session/model.js";
import { sessionForCall } from "../session/lifecycle.js";
import { widenAllowedHostsFromUrl } from "../session/registry.js";
import { norm, provisionElementRefs } from "./refs.js";
import type { Observation } from "../provision-session.js";

const compactV2SourcePages = new WeakMap<object, OAuthCompletionEvidence["page"]>();
const oauthCompletionSourcePages = new WeakMap<object, OAuthCompletionEvidence["page"]>();

function compactV2SourcePage(session: object): OAuthCompletionEvidence["page"] | undefined {
  const page = compactV2SourcePages.get(session);
  if (page?.isClosed()) {
    compactV2SourcePages.delete(session);
    return undefined;
  }
  return page;
}

export function rememberCompactV2SourcePage(
  session: object,
  page: OAuthCompletionEvidence["page"] | undefined,
): void {
  if (page === undefined) compactV2SourcePages.delete(session);
  else compactV2SourcePages.set(session, page);
}

export function oauthCompletionSourcePage(session: object): OAuthCompletionEvidence["page"] | undefined {
  return oauthCompletionSourcePages.get(session);
}

export function operationPageForSession(session: Session): Page | undefined {
  const page =
    oauthCompletionSourcePage(session) ??
    (session.compactV2Active ? compactV2SourcePage(session) : undefined) ??
    session.browser.activePage() ??
    undefined;
  return returnFromClosedPicker(session, page);
}

export function returnFromClosedPicker(session: Session, page: Page | undefined): Page | undefined {
  if (page === undefined || !page.isClosed()) return page;
  const opener = session.browser.returnFromClosedPopup(page);
  if (opener === null) return page;
  // Only post-click perception follows the opener. The dispatched target and
  // any field verification stay bound to the original popup document.
  if (oauthCompletionSourcePage(session) !== undefined) {
    rememberOAuthCompletionSourcePage(session, opener);
  } else if (session.compactV2Active) {
    rememberCompactV2SourcePage(session, opener);
  }
  invalidateCompactV2Snapshot(session);
  return opener;
}

export function rememberOAuthCompletionSourcePage(
  session: object,
  page: OAuthCompletionEvidence["page"] | undefined,
): void {
  if (page === undefined) oauthCompletionSourcePages.delete(session);
  else oauthCompletionSourcePages.set(session, page);
}

export function invalidateCompactV2Snapshot(
  session: Pick<Session, "compactV2Refs" | "compactV2Index" | "compactV2Previous">,
): void {
  session.compactV2Refs = new Map();
  session.compactV2Index = null;
  session.compactV2Previous = null;
  compactV2SourcePages.delete(session);
}

/** Wire-visible equality for the action response's changed-control delta. */
function sameCompactV2Control(left: SafeControlV2, right: SafeControlV2): boolean {
  return (
    left.ref === right.ref &&
    left.role === right.role &&
    left.state === right.state &&
    left.visibility === right.visibility &&
    left.action === right.action &&
    left.field === right.field &&
    left.label === right.label &&
    left.choice === right.choice &&
    left.frame === right.frame &&
    left.match === right.match &&
    left.notFillable === right.notFillable
  );
}

// Observation verbosity, set per call via operate_observe{format} /
// operate_act{detail}:
//   "none"    — bare ack, no perception (operate_act only; for chained fills).
//   "compact" — the paged browser-use control map. The DEFAULT.
//   "full"    — the browser-use DOM tree.
export type ObserveDetail = "none" | "compact" | "full";

export interface CompactV2StartMetadata {
  hintPages?: string[];
  userEmail?: string;
}

/**
 * Last index in `page` at which a split leaves complete whitespace-delimited
 * tokens on both sides (the position right after the final whitespace run), or
 * -1 when the page holds no interior token boundary.
 */
function lastUtf8TokenBoundary(page: string): number {
  const match = /\s(?=\S*$)/.exec(page);
  return match === null ? -1 : match.index + 1;
}

/**
 * Split `value` into byte-bounded pages LOSSLESSLY (concatenating the pages
 * reproduces the input) and at TOKEN boundaries: an overflow never cuts a word
 * or URL mid-token when an interior boundary exists — the ipinfo dogfood read
 * "- entry: https://ipin" off page 0 and had to spend an extra paging call to
 * reassemble trusted routing metadata. Only a single token longer than a whole
 * page falls back to the old character split.
 */
function splitUtf8Pages(value: string, maxBytes: number): string[] {
  if (value.length === 0) return [];
  const pages: string[] = [];
  let page = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes && page.length > 0) {
      const boundary = lastUtf8TokenBoundary(page);
      if (boundary > 0) {
        const rest = page.slice(boundary);
        pages.push(page.slice(0, boundary));
        page = rest;
        bytes = Buffer.byteLength(rest, "utf8");
      } else {
        pages.push(page);
        page = "";
        bytes = 0;
      }
    }
    page += character;
    bytes += characterBytes;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export function compactV2StartMetadata(
  registryHint: string | undefined,
  loginHint: string,
  userEmail: string | null,
): CompactV2StartMetadata {
  const hint = [loginHint, registryHint]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n");
  const validEmail =
    userEmail !== null &&
    Buffer.byteLength(userEmail, "utf8") <= 254 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(userEmail)
      ? userEmail
      : undefined;
  return {
    ...(hint.length === 0 ? {} : { hintPages: splitUtf8Pages(hint, 384) }),
    ...(validEmail === undefined ? {} : { userEmail: validEmail }),
  };
}

/**
 * Scope for the default map's overflow paging cursors. Deliberately NOT bound
 * to a query/role: the map ordering is canonical and any filter rides on top
 * of paging. Binding the scope to the exact query/role (the old behavior)
 * made the model's natural "page the overflow, looking for X" call — a map
 * cursor plus a search term — fail with invalid_cursor on every attempt (the
 * live Xata failure).
 */
function compactV2ControlCursorScope(session: Session): string {
  return createHmac("sha256", session.compactV2Secret)
    .update("control-map-paging")
    .digest("base64url")
    .slice(0, 10);
}

function compactV2QueryCursorScope(
  session: Session,
  query: string,
  role: SafeControlV2["role"] | undefined,
): string {
  return createHmac("sha256", session.compactV2Secret)
    .update(JSON.stringify([query, role ?? null]))
    .digest("base64url")
    .slice(0, 10);
}

function compactV2HintCursorScope(session: Session): string {
  return createHmac("sha256", session.compactV2Secret)
    .update("start-metadata")
    .digest("base64url")
    .slice(0, 10);
}

interface CompactV2PagingSnapshot {
  id: string;
  scope: string;
  epoch: ObservationEpochV2;
  stage: SafeStageV2;
  semantics: SafePageSemanticsV2;
  pageUrl: string;
  rows: readonly SafeControlV2[];
  hintPages: readonly string[];
  expiresAt: number;
}

const compactV2PagingSnapshots = new WeakMap<
  Session,
  { sequence: number; snapshots: Map<string, CompactV2PagingSnapshot> }
>();
const COMPACT_V2_MAX_PAGING_SNAPSHOTS = 12;

function retainCompactV2PagingSnapshot(
  session: Session,
  index: SafeObservationIndexV2,
  scope: string,
  pageUrl: string,
  rows: readonly SafeControlV2[],
  hintPages: readonly string[] = [],
): CompactV2PagingSnapshot {
  let state = compactV2PagingSnapshots.get(session);
  if (state === undefined) {
    state = { sequence: 0, snapshots: new Map() };
    compactV2PagingSnapshots.set(session, state);
  }
  const now = Date.now();
  for (const [id, snapshot] of state.snapshots) {
    if (snapshot.expiresAt < now) state.snapshots.delete(id);
  }
  const snapshot: CompactV2PagingSnapshot = {
    id: (++state.sequence).toString(36),
    scope,
    epoch: { ...index.epoch },
    stage: index.stage,
    semantics: { ...index.semantics },
    pageUrl,
    rows: rows.map((row) => ({ ...row })),
    hintPages: [...hintPages],
    expiresAt: Math.min(index.expiresAt, now + 5 * 60_000),
  };
  state.snapshots.set(snapshot.id, snapshot);
  while (state.snapshots.size > COMPACT_V2_MAX_PAGING_SNAPSHOTS) {
    const oldest = state.snapshots.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    state.snapshots.delete(oldest);
  }
  return snapshot;
}

function compactV2Cursor(
  session: Session,
  snapshot: CompactV2PagingSnapshot,
  offset: number,
): string {
  // The cursor identifies an immutable, bounded paging snapshot. Fresh reads
  // may replace the live action map without changing what an older cursor
  // means; action-time resolution still revalidates every returned ref.
  const body = `${snapshot.id}:${snapshot.epoch.rev.toString(36)}:${offset.toString(36)}:${snapshot.scope}`;
  const signature = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  return `${body}.${signature}`;
}

// A live checkout mints a per-checkout token INTO ITS PATH and re-writes it as
// the checkout SPA re-renders a step. The token names the checkout, never the
// document, so folding it into `doc` retires every ref between two fills of one
// address block. This is the path-side twin of the query/fragment exclusion
// PR #624 landed; it is deliberately a CLOSED list of known checkout shapes —
// every other path keeps its full identity, so an SPA route change to a
// different logical page still retires refs.
const VOLATILE_CHECKOUT_PATH_RULES: readonly RegExp[] = [
  // Shopify hosted checkout, current (`…/checkouts/cn/<token>[/<step>]`) and
  // legacy (`…/checkouts/c|co/<token>[/<step>]`), under any locale/shop prefix.
  // The marker must be a whole segment, so a token that merely starts with "c"
  // cannot be split across the capture.
  /^(.*\/checkouts\/c[no]?)\/([^/]+)(?:\/.*)?$/i,
  // Older Shopify: `/<shop-id>/checkouts/<token>[/<step>]`.
  /^(.*\/checkouts)\/([^/]+)(?:\/.*)?$/i,
];

/**
 * Generated, not authored. An authored path slug under `/checkouts/` (a docs
 * page, a marketing route) must keep its own identity, so the token has to look
 * minted: long, in the URL-safe token alphabet, and carrying a digit.
 */
function looksLikeVolatileCheckoutToken(segment: string): boolean {
  return segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment);
}

/**
 * Collapse a known-volatile checkout path onto one logical-page key. The step
 * suffix collapses with the token: inside a single checkout the steps are
 * same-document SPA routing, and a move to a DIFFERENT checkout replaces the
 * document, which the primary document-identity signal catches.
 */
function normalizeVolatileCheckoutPath(pathname: string): string {
  for (const rule of VOLATILE_CHECKOUT_PATH_RULES) {
    const match = rule.exec(pathname);
    if (match !== null && looksLikeVolatileCheckoutToken(match[2]!)) {
      return `${match[1]}/:checkout`;
    }
  }
  return pathname;
}

// The `doc` half of the observation epoch (docs/observation-model.md §4.1):
// the browser's stable main-document identity, not the URL. The full URL is too
// volatile to key on — live checkouts (e.g. Shopify) rotate a token in the
// query string AND in the path on every step re-render, which would invalidate
// every ref between two acts. A NORMALIZED origin+pathname is folded in as a
// fail-closed backstop for a host whose document identity does not move on a
// logical page change; query-string, fragment, and known-volatile checkout
// token churn on the same logical page must not invalidate.
export function compactV2EpochDoc(
  session: Session,
  page: OAuthCompletionEvidence["page"] | undefined = operationPageForSession(session),
): string {
  let location = page?.url() ?? session.browser.currentUrl();
  try {
    const parsed = new URL(location);
    if (parsed.origin !== "null" && parsed.origin !== "")
      location = `${parsed.origin}${normalizeVolatileCheckoutPath(parsed.pathname)}`;
  } catch {}
  return createHmac("sha256", session.compactV2Secret)
    .update(`${session.browser.mainDocumentIdentity(page)}\u0000${location}`)
    .digest("base64url");
}

// Weak ownership keeps allocator lifetime bound to the session without retaining
// closed sessions. One namespace/counter serves both action and display refs.
const observationRefs = new WeakMap<Session, StableObservationRefs>();
export function compactV2RefAllocator(session: Session): StableObservationRefs {
  let refs = observationRefs.get(session);
  if (!refs) {
    refs = new StableObservationRefs(session.compactV2Secret);
    observationRefs.set(session, refs);
  }
  return refs;
}
function compactV2StableRef(session: Session, doc: string, identity: string): string {
  return compactV2RefAllocator(session).get(doc, identity);
}

/** Reconcile physical anchors once for the shared DOM/action inventory. */
function compactV2Handles(
  session: Session,
  elements: readonly InteractiveElement[],
  page: OAuthCompletionEvidence["page"] | undefined = compactV2SourcePage(session),
): Map<InteractiveElement, string> {
  const doc = compactV2EpochDoc(session, page);
  return compactV2RefAllocator(session).actions(doc, elements);
}

/** The live skeleton for an element inventory, under the session's epoch. */
export function compactV2LiveControls(
  session: Session,
  elements: readonly InteractiveElement[],
  page: OAuthCompletionEvidence["page"] | undefined = compactV2SourcePage(session),
  handles: ReadonlyMap<InteractiveElement, string> = compactV2Handles(session, elements, page),
): { rows: SafeControlV2[]; byRef: Map<string, string> } {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(page?.url() ?? session.browser.currentUrl()).origin;
  } catch {}
  const pageUrl = page?.url() ?? session.browser.currentUrl();
  return buildSafeControlsV2({
    elements,
    legacyRefs: provisionElementRefs(elements),
    handles,
    pageOrigin,
    pageUrl,
    canonical: true,
    anchorLabel: (ref, label) => compactV2RefAllocator(session).label(ref, label),
  });
}

function parseCompactV2Cursor(
  session: Session,
  cursor: string,
  expectedScope: string,
): { snapshot: CompactV2PagingSnapshot; offset: number } {
  const [body, signature, extra] = cursor.split(".");
  if (body === undefined || signature === undefined || extra !== undefined)
    throw new Error("invalid_cursor");
  const expected = createHmac("sha256", session.compactV2Secret)
    .update(body)
    .digest("base64url")
    .slice(0, 12);
  if (signature !== expected) throw new Error("invalid_cursor");
  const [id, revRaw, offsetRaw, scope, extraPart] = body.split(":");
  if (
    id === undefined ||
    revRaw === undefined ||
    offsetRaw === undefined ||
    scope === undefined ||
    extraPart !== undefined ||
    scope !== expectedScope
  ) {
    throw new Error("invalid_cursor");
  }
  const rev = Number.parseInt(revRaw, 36);
  const offset = Number.parseInt(offsetRaw, 36);
  if (
    !Number.isSafeInteger(rev) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    rev.toString(36) !== revRaw ||
    offset.toString(36) !== offsetRaw
  ) {
    throw new Error("stale_cursor");
  }
  const snapshot = compactV2PagingSnapshots.get(session)?.snapshots.get(id);
  if (
    snapshot === undefined ||
    snapshot.scope !== expectedScope ||
    snapshot.epoch.rev !== rev ||
    snapshot.expiresAt < Date.now()
  ) {
    throw new Error("stale_cursor");
  }
  return { snapshot, offset };
}

function compactV2HintPage(
  session: Session,
  snapshot: CompactV2PagingSnapshot,
  offset: number,
): Record<string, unknown> {
  const hint = snapshot.hintPages[offset];
  if (hint === undefined) throw new Error("invalid_cursor");
  const nextOffset = offset + 1;
  const remaining = snapshot.hintPages.length - nextOffset;
  const payload = {
    format: "browser-use-control-query",
    url: "",
    session_id: session.id,
    stage: snapshot.stage,
    hint,
    ...(remaining > 0
      ? {
          hint_overflow: {
            remaining,
            next_cursor: compactV2Cursor(session, snapshot, nextOffset),
          },
        }
      : {}),
  };
  // Start hints are routing metadata; degrade rather than fail the page.
  const degraded = compactV2DegradeMetadata(payload);
  if (degraded === null) throw new Error("compact-v2 budget metadata exceeded");
  return degraded;
}

export function compactV2PublicObservation(
  session: Session,
  fields: {
    stage: SafeStageV2;
    guidance?: string;
    oauth?: Observation["oauth"];
    observed?: ObserveDetail;
    terminal?: Observation["terminal"];
    url?: string;
  },
  outputFormat: "compact" | "full" = "full",
): Observation {
  session.compactV2Active = true;
  const payload = {
    format:
      outputFormat === "compact"
        ? ("browser-use-control-query" as const)
        : ("browser-use-dom" as const),
    session_id: session.id,
    url: fields.url ?? session.browser.currentUrl(),
    stage: fields.stage,
    ...(outputFormat === "compact" ? { safe_table: [] } : {}),
    ...(fields.guidance === undefined ? {} : { guidance: fields.guidance }),
    ...(fields.oauth === undefined ? {} : { oauth: fields.oauth }),
    ...(fields.observed === undefined ? {} : { observed: fields.observed }),
    ...(fields.terminal === undefined ? {} : { terminal: fields.terminal }),
  };
  // Fixed metadata (long OAuth-shaped URLs) degrades before observation ever
  // fails; the throw is unreachable from real pages.
  const degraded = compactV2DegradeMetadata(payload as unknown as Record<string, unknown>);
  if (degraded === null) throw new Error("compact-v2 budget metadata exceeded");
  return degraded as unknown as Observation;
}

function compactV2Observation(
  session: Session,
  generation: number,
  capture: BrowserUseCapture,
  semanticSource: ObservationSemanticSourceV2,
  startMetadata?: CompactV2StartMetadata,
  sourcePage?: OAuthCompletionEvidence["page"],
  outputFormat: "compact" | "full" = "full",
  compactActionDelta = false,
  compactMapEmitted = true,
  forceFullDOM = false,
  actedRef?: string,
): Observation {
  rememberCompactV2SourcePage(session, sourcePage);
  const elements = capture.elements;
  if (startMetadata?.hintPages !== undefined)
    session.compactV2HintPages = [...startMetadata.hintPages];
  const pageUrl = sourcePage?.url() ?? session.browser.currentUrl();
  const stage = safeStageV2(pageUrl, elements);
  const epochDoc = compactV2EpochDoc(session, sourcePage);
  const previous = session.compactV2Previous;
  const sameDocument = previous !== null && previous.epoch.doc === epochDoc;
  const sameFullDocument = sameDocument && previous.dom !== undefined;
  const handles = compactV2Handles(session, elements, sourcePage);
  const safe = compactV2LiveControls(session, elements, sourcePage, handles);
  const targetableRefs = new Set(safe.rows.map((row) => row.ref));
  const semanticBase = safePageSemanticsV2(semanticSource);
  // Page-level error evidence (e.g. a CDN block page named from title/headings)
  // leads the list; DOM-derived blockers follow, capped at the shared maximum.
  const blockers = [
    ...(semanticBase.blockers ?? []),
    ...safeBlockersV2(capture.root, (node) => {
    const element = capture.nodeElements.get(node.id);
    const ref = element === undefined ? undefined : handles.get(element);
    return ref !== undefined && targetableRefs.has(ref) ? ref : undefined;
  })].slice(0, BLOCKER_MAX_ITEMS);
  const semantics = {
    ...semanticBase,
    ...(blockers.length === 0 ? {} : { blockers, blocked: true as const }),
  };
  const rendered = serializeBrowserUseDOM(capture.root, {
    ref: (node) => {
      const element = capture.nodeElements.get(node.id);
      const ref = element === undefined ? undefined : handles.get(element);
      if (ref !== undefined) return ref;
      // Display-only identities share the allocator but not the action namespace.
      return {
        ref: compactV2StableRef(session, epochDoc, `unbound\u001f${node.id}`),
        targetable: false,
      };
    },
    ...(sameFullDocument ? { previous: new Set(previous.renderedRefs ?? []) } : {}),
  });
  // Emit canonical names and text verbatim, preserving whitespace, line order
  // and indentation; no prose extraction or byte-budget pruning.
  const dom = rendered.dom;
  // A changed URL, frame set, or closed-shadow/iframe structure is a real
  // change even when the rendered text is byte-identical: the observation the
  // host already holds describes a page that no longer exists.
  const structurallyChanged =
    previous !== null && (previous.dynamics !== capture.dynamics || previous.url !== pageUrl);
  const changed = !sameFullDocument || previous.dom !== dom || structurallyChanged;
  const epoch = { doc: epochDoc, rev: changed ? generation : previous.epoch.rev };
  session.compactV2Active = true;
  session.compactV2Index = {
    epoch,
    stage,
    semantics,
    rows: safe.rows,
    byRef: safe.byRef,
    expiresAt: Date.now() + 5 * 60_000,
  };
  const canCompactActionDelta =
    outputFormat === "compact" &&
    compactActionDelta &&
    sameDocument &&
    previous.compactMapEmitted === true;
  const currentRefs = new Set(safe.rows.map((row) => row.ref));
  const compactRows = canCompactActionDelta
    ? safe.rows.flatMap((row) => {
        // E4: the acted control's current row always travels in the action
        // delta, marked w=acted, even when nothing wire-visible changed —
        // otherwise a successful write returns an empty safe_table and the
        // only way to confirm it is a full format:full re-read. The handle is
        // minted from physical node identity, so it survives the benign
        // re-render the action itself may have caused.
        if (actedRef !== undefined && row.ref === actedRef) return [{ ...row, acted: true as const }];
        const prior = previous.byRef.get(row.ref);
        return prior === undefined || !sameCompactV2Control(prior, row) ? [row] : [];
      })
    : safe.rows;
  const compactRemoved = canCompactActionDelta
    ? [...previous.byRef.keys()].filter((ref) => !currentRefs.has(ref))
    : [];
  let controlSnapshot = retainCompactV2PagingSnapshot(
    session,
    session.compactV2Index,
    compactV2ControlCursorScope(session),
    pageUrl,
    compactRows,
  );
  const hintSnapshot =
    session.compactV2HintPages.length > 1
      ? retainCompactV2PagingSnapshot(
          session,
          session.compactV2Index,
          compactV2HintCursorScope(session),
          pageUrl,
          [],
          session.compactV2HintPages,
        )
      : undefined;
  session.compactV2Refs = safe.byRef;
  session.compactV2Previous = {
    epoch,
    stage,
    semantics,
    byRef: new Map(safe.rows.map((row) => [row.ref, row])),
    ...(outputFormat === "full"
      ? { dom, renderedRefs: rendered.refs, url: pageUrl, dynamics: capture.dynamics }
      : sameFullDocument
        ? {
            dom: previous.dom,
            renderedRefs: previous.renderedRefs,
            url: previous.url,
            dynamics: previous.dynamics,
          }
        : {}),
  };
  if (outputFormat === "compact") {
    const encodePage = (delta: boolean) =>
      encodeV2QueryPage({
        sessionId: session.id,
        stage,
        pageUrl,
        semantics,
        rows: delta ? compactRows : safe.rows,
        ...(delta ? { delta: true as const, removed: compactRemoved } : {}),
        cursorFor: (next) => compactV2Cursor(session, controlSnapshot, next),
        ...(startMetadata === undefined
          ? {}
          : {
              startMetadata: {
                ...(startMetadata.hintPages?.[0] === undefined
                  ? {}
                  : { hint: startMetadata.hintPages[0] }),
                ...(startMetadata.userEmail === undefined
                  ? {}
                  : { userEmail: startMetadata.userEmail }),
                ...(session.compactV2HintPages.length <= 1
                  ? {}
                  : {
                      hintOverflow: {
                        remaining: session.compactV2HintPages.length - 1,
                        next_cursor: compactV2Cursor(session, hintSnapshot!, 1),
                      },
                    }),
              },
            }),
      });
    let page;
    try {
      page = encodePage(canCompactActionDelta);
    } catch (error) {
      if (
        !canCompactActionDelta ||
        !(error instanceof Error) ||
        error.message !== "compact-v2 budget metadata exceeded"
      )
        throw error;
      controlSnapshot = retainCompactV2PagingSnapshot(
        session,
        session.compactV2Index,
        compactV2ControlCursorScope(session),
        pageUrl,
        safe.rows,
      );
      page = encodePage(false);
    }
    if (compactMapEmitted && page.payload.overflow === undefined)
      session.compactV2Previous.compactMapEmitted = true;
    return {
      ...page.payload,
      ...(capture.omissions.length === 0 ? {} : { capture_omissions: capture.omissions }),
    } as unknown as Observation;
  }
  const removed = sameDocument
    ? (previous.renderedRefs ?? []).filter((ref) => !rendered.refs.includes(ref))
    : [];
  return {
    format: "browser-use-dom",
    session_id: session.id,
    url: pageUrl,
    stage,
    ...(sameFullDocument ? { delta: true } : {}),
    ...(changed || forceFullDOM ? { dom } : { dom_unchanged: true as const }),
    ...(removed.length ? { removed } : {}),
    more_above: capture.moreAbove,
    more_below: capture.moreBelow,
    ...(capture.omissions.length === 0 ? {} : { capture_omissions: capture.omissions }),
    ...(startMetadata?.hintPages?.[0] ? { hint: startMetadata.hintPages[0] } : {}),
    ...(startMetadata?.userEmail ? { user_email: startMetadata.userEmail } : {}),
    ...(session.compactV2HintPages.length > 1 && startMetadata
      ? {
          hint_overflow: {
            remaining: session.compactV2HintPages.length - 1,
            next_cursor: compactV2Cursor(session, hintSnapshot!, 1),
          },
        }
      : {}),
  } as unknown as Observation;
}

export async function observeQuery(
  sessionId: string,
  query: string,
  role?: SafeControlV2["role"],
  cursor?: string,
): Promise<Record<string, unknown>> {
  const result = await observeQueryOwned(sessionId, query, role, cursor);
  const oauth = await observedOAuthChallenge(sessionId);
  const threeDs = await observedThreeDsChallenge(sessionId);
  return {
    ...result,
    ...(oauth === undefined ? {} : { oauth }),
    ...(threeDs === undefined ? {} : { three_ds: threeDs }),
  };
}

async function observeQueryOwned(
  sessionId: string,
  query: string,
  role?: SafeControlV2["role"],
  cursor?: string,
): Promise<Record<string, unknown>> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const sourcePage = operationPageForSession(session);
  const needle = norm(query);
  // A role filter is stated in wire form — the letters (and literal roles) the
  // compact map actually emits (C5): filtering `role:"s"` against the internal
  // `"select"` word made every observation with a role filter return an empty
  // safe_table for controls the same session had just emitted.
  const roleFilter = role === undefined ? undefined : wireRoleToSafeRoleV2(role);
  const unfiltered = needle.length === 0 && roleFilter === undefined;
  const cursorScope = unfiltered
    ? compactV2ControlCursorScope(session)
    : compactV2QueryCursorScope(session, needle, roleFilter);
  if (cursor !== undefined) {
    if (unfiltered) {
      try {
        const parsed = parseCompactV2Cursor(session, cursor, compactV2HintCursorScope(session));
        if (parsed.snapshot.epoch.doc !== compactV2EpochDoc(session, sourcePage))
          throw new Error("stale_cursor");
        return compactV2HintPage(session, parsed.snapshot, parsed.offset);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "invalid_cursor") throw error;
      }
    }
    const parsed = parseCompactV2Cursor(session, cursor, cursorScope);
    const snapshot = parsed.snapshot;
    if (snapshot.epoch.doc !== compactV2EpochDoc(session, sourcePage)) {
      throw new Error("stale_cursor");
    }
    const page = encodeV2QueryPage({
      sessionId: session.id,
      stage: snapshot.stage,
      pageUrl: snapshot.pageUrl,
      semantics: snapshot.semantics,
      rows: snapshot.rows,
      offset: parsed.offset,
      cursorFor: (next) => compactV2Cursor(session, snapshot, next),
    });
    return page.payload;
  }

  // A cursorless query/role is always a fresh observation. Capture action rows
  // and semantic page hints once, together, before filtering.
  session.generation += 1;
  const capture = await session.browser.extractBrowserUseObservation(sourcePage, true);
  let semanticSource: ObservationSemanticSourceV2 = { title: "", headings: [] };
  try {
    semanticSource = await session.browser.extractObservationSemantics(sourcePage);
  } catch {
    // Semantics are optional; action membership comes from the canonical capture.
  }
  compactV2Observation(
    session,
    session.generation,
    capture,
    semanticSource,
    undefined,
    sourcePage,
    "compact",
    false,
    false,
  );
  const index = session.compactV2Index;
  if (index === null) throw new Error("stale_cursor");
  const liveElements = capture.elements;
  const liveByLegacy = new Map<string, InteractiveElement>();
  for (const [element, legacy] of provisionElementRefs(liveElements)) {
    liveByLegacy.set(legacy, element);
  }
  const ranked = index.rows.flatMap((row, position) => {
    if (roleFilter !== undefined && row.role !== roleFilter) return [];
    if (needle.length === 0) return [{ row, position, rank: 0 }];
    const legacy = index.byRef.get(row.ref);
    const element = legacy === undefined ? undefined : liveByLegacy.get(legacy);
    const match = element === undefined ? null : controlQueryMatchV2(element, query);
    const semanticMatch = [row.role, row.action, row.field].some(
      (value) => value !== undefined && norm(value) === needle,
    );
    if (match === null && !semanticMatch) return [];
    return [
      {
        row: { ...row, match: match?.provenance ?? ("text" as const) },
        position,
        rank: match?.rank ?? 2,
      },
    ];
  });
  ranked.sort((left, right) => left.rank - right.rank || left.position - right.position);
  const rows = ranked.map(({ row }) => row);
  const pageUrl = sourcePage?.url() ?? session.browser.currentUrl();
  const snapshot = retainCompactV2PagingSnapshot(session, index, cursorScope, pageUrl, rows);
  const page = encodeV2QueryPage({
    sessionId: session.id,
    stage: snapshot.stage,
    pageUrl: snapshot.pageUrl,
    semantics: index.semantics,
    rows,
    cursorFor: (next) => compactV2Cursor(session, snapshot, next),
  });
  return page.payload;
}

export async function observedOAuthChallenge(
  sessionId: string,
): Promise<Observation["oauth"] | undefined> {
  const session = sessionForCall(sessionId);
  const error = await (session?.browser ? refreshOAuthHumanChallenge(session.browser) : undefined);
  if (error == null || error.challenge === undefined) return undefined;
  return {
    state: "awaiting_human",
    reason: error.message,
    next_action: "operate_observe",
    challenge: error.challenge,
    ...(error.notification === undefined ? {} : { notification: error.notification }),
  };
}

export async function observedThreeDsChallenge(
  sessionId: string,
): Promise<Observation["three_ds"] | undefined> {
  const session = sessionForCall(sessionId);
  if (session === undefined) return undefined;
  const released = session.releasedPaymentCard;
  if (released === null) return undefined;
  const challenge = await session.browser.detectThreeDsChallenge().catch(() => null);
  if (challenge === null) return undefined;
  let notified: boolean | undefined;
  if (released.threeDsNotified !== true) {
    released.threeDsNotified = true;
    try {
      notified = (await session.api?.notifyThreeDs(released.approvalId, "detected_challenge"))
        ?.sent;
    } catch {
      notified = false;
    }
  }
  return {
    state: "challenge_detected",
    url: challenge.url,
    ...(notified === undefined ? {} : { notified }),
  };
}

export function terminalOAuthCompletionObservation(session: Session, url: string): Observation {
  const terminal: NonNullable<Observation["terminal"]> = {
    state: "oauth_completed",
    refs: "unavailable",
    next_action: "operate_observe",
  };
  rememberOAuthCompletionSourcePage(session, undefined);
  rememberCompactV2SourcePage(session, undefined);
  invalidateCompactV2Snapshot(session);
  retainSessionElements(session, []);
  const guidance =
    "OAuth completed in a popup that closed before its controls could be observed. " +
    "Call operate_observe to inspect the active product page.";
  return compactV2PublicObservation(session, {
    stage: safeStageV2(url, []),
    guidance,
    terminal,
    url,
  });
}

export async function observeSession(
  session: Session,
  _detail: "compact" | "full" = "compact",
  startMetadata?: CompactV2StartMetadata,
  sourcePage?: OAuthCompletionEvidence["page"],
  preserveSourceBinding = false,
  outputFormat: "compact" | "full" = "full",
  compactActionDelta = false,
  compactMapEmitted = true,
  forceFullDOM = false,
  actedRef?: string,
): Promise<Observation> {
  if (sourcePage === undefined) {
    const hadOAuthCompletionSource =
      oauthCompletionSourcePage(session) !== undefined ||
      compactV2SourcePage(session) !== undefined;
    session.browser.takeOAuthTerminalCompletionUrl();
    rememberOAuthCompletionSourcePage(session, undefined);
    rememberCompactV2SourcePage(session, undefined);
    if (hadOAuthCompletionSource) invalidateCompactV2Snapshot(session);
  }
  if (!preserveSourceBinding) rememberOAuthCompletionSourcePage(session, sourcePage);
  const oauthInProgress = (): Observation => {
    invalidateCompactV2Snapshot(session);
    const oauth = oauthTransitionStatus(session.browser);
    const guidance =
      "OAuth in progress: the provider detached or closed its page as expected. " +
      "Do not switch login methods or close the session; call operate_observe again to read the retained product page.";
    const state: NonNullable<Observation["oauth"]> = {
      state: "in_progress",
      provider_page: "closed_or_detached",
      next_action: "operate_observe",
    };
    completeOAuthTransitionRecovery(session.browser);
    return compactV2PublicObservation(
      session,
      {
        stage: "auth",
        guidance,
        oauth: state,
        url: oauth?.productUrl ?? session.startUrl,
      },
      outputFormat,
    );
  };
  try {
    if (sourcePage === undefined) {
      session.browser.recoverActivePage();
      const transition = oauthTransitionStatus(session.browser);
      if (
        transition?.providerPageClosed === true &&
        transition.productPageViable &&
        transition.browserConnected
      ) {
        return oauthInProgress();
      }
    }
    if (sourcePage === undefined) {
      widenAllowedHostsFromUrl(session, session.browser.currentUrl());
    }
    session.generation += 1;
    const generation = session.generation;
    const capture = await session.browser.extractBrowserUseObservation(sourcePage, true);
    retainSessionElements(session, capture.elements);
    let semanticSource: ObservationSemanticSourceV2 = { title: "", headings: [] };
    try {
      semanticSource = await session.browser.extractObservationSemantics(sourcePage);
    } catch {
      // Semantic context is optional availability-wise; it is independently
      // sealed below and never changes action-map safety.
    }
    return compactV2Observation(
      session,
      generation,
      capture,
      semanticSource,
      startMetadata,
      sourcePage,
      outputFormat,
      compactActionDelta,
      compactMapEmitted,
      forceFullDOM,
      actedRef,
    );
  } catch (err) {
    const oauth = session.browser ? oauthTransitionStatus(session.browser) : undefined;
    if (oauth?.providerPageClosed === true && oauth.productPageViable && oauth.browserConnected) {
      // A read racing an expected provider-page close must not leak the raw
      // Playwright "Target page, context or browser has been closed" exception
      // into the model's plan. Discard the delta baseline because the next
      // successful product-page read is a new authoritative snapshot.
      return oauthInProgress();
    }
    throw err;
  }
}
