// Phase 1 — the session-holding "thick tools" surface a frontier host agent
// drives. MCP tool calls are stateless, but a provision run needs ONE live
// browser held across many calls; this module is that registry + the
// observe/act loop over the existing BrowserController substrate.
//
// Two findings from the 2026-06 spikes are load-bearing here:
//  - target elements by TEXT/ROLE with re-resolution every act, never by a
//    positional index (indices drift as the SPA re-renders).
//  - the OAuth popup is the fragile part; route OAuth clicks through the
//    substrate's startOAuth/settleAfterOAuth, which already adopt the popup.
//
// Design notes:
//  - domain-scope gates only AGENT-INITIATED `goto`. Organic OAuth redirects
//    (which bounce through accounts.google.com, *.firebaseapp.com, etc.) are
//    not navigation the agent chose, so they are never blocked.
//  - no credential is ever read back to the agent except via the explicit
//    `finish`/extract path; the vault stays write-only.

import { createHash, randomUUID } from "node:crypto";
import { BrowserController, type InteractiveElement } from "./browser.js";
import { extractApiKeyFromText, isTruncatedCapture, pickVerificationLink } from "./agent.js";
import { loginSessionGuidance } from "./skill-hint.js";
import type { OAuthProviderId } from "./oauth-providers.js";
import {
  initialExtractionState,
  accumulateCandidate,
  hasFullHit,
  resolveExtraction,
  type CandidateClass,
} from "./extraction.js";

// Identity-provider + auth-handler hosts a signup legitimately bounces
// through. Used to widen domain-scope so an OAuth `goto` (rare) isn't blocked.
// Organic redirects are already exempt (scope only gates explicit goto).
const DEFAULT_AUTH_HOSTS: readonly string[] = [
  "accounts.google.com",
  "github.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
];

export interface ObservedElement {
  // Fresh action handle for this exact observation generation. Prefer this as
  // provision_act.target; stale generations fail loudly instead of silently
  // clicking a recycled DOM node.
  ref: string;
  // Human label for display/backcompat. provision_act still accepts labels, but
  // generated refs are safer on pages with repeated labels.
  label: string;
  tag: string;
  role: string | null;
  type: string | null;
  value: string | null;
  checked: boolean | null;
  // Link target, so the agent can see where a nav item goes and `goto` it
  // directly instead of guessing URLs (a live LangWatch run hit a 404 guessing
  // /settings because the sidebar "Settings" is a hover-expand with the real
  // path only in its href). Null for non-link elements.
  href: string | null;
  // The site's own stable test hook (data-testid/-cy/-qa), the most
  // refactor-resilient target when present.
  testId: string | null;
  // DOM-derived screen context for non-vision host agents. `path` is a compact
  // targetable label such as "dialog:finish-account > button:create-account".
  path: string | null;
  container: string | null;
  topmost: boolean | null;
  occluded_by: string | null;
}

export interface ScreenRegion {
  id: string;
  role: string;
  topmost: boolean;
  occluded_by: string | null;
  children: Array<{
    ref: string;
    role: string | null;
    text: string | null;
    href: string | null;
    topmost: boolean | null;
    occluded_by: string | null;
  }>;
}

export interface ScreenOutline {
  foreground: string | null;
  mode_markers: string[];
  regions: ScreenRegion[];
}

export interface Observation {
  session_id: string;
  url: string;
  // Registry route guidance, present ONLY on the first (start) observation when
  // a skill exists for the service. The host agent reads it before driving.
  hint?: string;
  // Layout-aware page prose (innerText) so the agent can read passages,
  // questions, masked-key hints, etc. Capped to keep tool payloads bounded.
  text: string;
  // Domain-aware steering for the host planner. This is not a script; it is
  // guardrail context for states the raw page text routinely misleads agents on.
  guidance?: string;
  // Compact relational view of interactive DOM regions. This is intentionally
  // smaller than raw DOM but preserves hierarchy/occlusion that flat text loses.
  screen?: ScreenOutline;
  // AXI-style planner scan surface. Additive: the rich elements[] inventory
  // remains the source of truth for actionability/state.
  accessibility?: AccessibilitySnapshot;
  elements: ObservedElement[];
}

export interface AccessibilitySnapshot {
  tree: string;
  refs: number;
  truncated: boolean;
  total_chars: number;
  source: "interactive_dom";
}

export type ProvisionAction =
  | { kind: "click"; target: string }
  // JS-dispatched click (el.click()) — use when a plain click on a custom
  // React card/widget didn't register its onClick (the stochastic radio-card
  // stall). Same target resolution; different dispatch.
  | { kind: "js_click"; target: string }
  | { kind: "type"; target: string; text: string }
  | { kind: "goto"; url: string }
  | { kind: "press"; key: string }
  // Route an OAuth-provider button through startOAuth so the popup is adopted
  // as the active page (the host then observes the account chooser/consent).
  | { kind: "oauth_click"; target: string }
  // Return to the product page after the OAuth handshake completes.
  | { kind: "oauth_settle" };

interface Session {
  id: string;
  browser: BrowserController;
  allowedHosts: string[];
  generation: number;
  // The last extracted elements, kept so resolveTarget can be unit-tested
  // against a snapshot, but act() always RE-extracts first (re-resolution).
  lastElements: InteractiveElement[];
}

const sessions = new Map<string, Session>();

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Audit trail (security posture): every session action emits one structured
// stderr line the host's MCP log captures. The `provision-audit` marker makes
// the trail greppable. No credential VALUES are ever logged — only the action
// shape + url.
function audit(sessionId: string, event: string, detail: Record<string, unknown> = {}): void {
  process.stderr.write(
    `${JSON.stringify({ marker: "provision-audit", session_id: sessionId, event, ...detail })}\n`,
  );
}

// ── pure helpers (exported for unit tests) ──

const norm = (s: string | null | undefined): string =>
  (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

const PROVISION_REF_RE = /^@?g(\d+):([a-z0-9_-]+)$/i;
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

export function stableElementId(el: InteractiveElement): string {
  return shortHash(
    [
      el.screenPath ?? "",
      el.testId ?? "",
      el.container ?? "",
      el.role ?? "",
      el.tag,
      elementRef(el),
      el.href ?? "",
      el.type ?? "",
    ].join("\u001f"),
  );
}

export function provisionElementRef(
  el: InteractiveElement,
  generation: number,
  ordinal = 1,
): string {
  return `@g${generation}:${stableElementId(el)}_${ordinal}`;
}

function parseProvisionRef(
  target: string,
): { generation: number; id: string; ordinal: number | null } | null {
  const m = target.trim().match(PROVISION_REF_RE);
  if (m === null) return null;
  const rawId = m[2] as string;
  const idMatch = rawId.match(PROVISION_REF_ID_RE);
  return {
    generation: Number.parseInt(m[1] as string, 10),
    id: idMatch !== null ? (idMatch[1] as string) : rawId,
    ordinal: idMatch !== null ? Number.parseInt(idMatch[2] as string, 10) : null,
  };
}

export function provisionElementRefs(
  elements: readonly InteractiveElement[],
  generation: number,
): Map<InteractiveElement, string> {
  const seen = new Map<string, number>();
  const refs = new Map<InteractiveElement, string>();
  for (const el of elements) {
    const id = stableElementId(el);
    const ordinal = (seen.get(id) ?? 0) + 1;
    seen.set(id, ordinal);
    refs.set(el, provisionElementRef(el, generation, ordinal));
  }
  return refs;
}

export class StaleProvisionRefError extends Error {
  readonly code = "stale_ref";

  constructor(
    readonly refGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `stale_ref: target is from observation generation ${refGeneration}, ` +
        `but current generation is ${currentGeneration}. Call provision_observe and retry with a fresh ref.`,
    );
  }
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

function elementTargetKeys(el: InteractiveElement): string[] {
  return [el.screenPath ?? null, el.testId ?? null, elementRef(el)].flatMap((s) => {
    const v = (s ?? "").replace(/\s+/g, " ").trim();
    return v.length > 0 ? [v] : [];
  });
}

// Resolve a host-supplied target string to one live element. Matching is by
// structured path, test id, or label text, scored exact > startsWith > contains.
// Returns null when nothing matches — the caller surfaces that rather than
// guessing.
export function resolveTarget(
  elements: readonly InteractiveElement[],
  target: string,
  currentGeneration?: number,
): InteractiveElement | null {
  const parsedRef = parseProvisionRef(target);
  if (parsedRef !== null) {
    if (currentGeneration !== undefined && parsedRef.generation !== currentGeneration) {
      throw new StaleProvisionRefError(parsedRef.generation, currentGeneration);
    }
    const matches = elements.filter((el) => stableElementId(el) === parsedRef.id);
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

// Domain-scope check for an agent-initiated goto. Allows the target host, any
// subdomain of it, the configured auth hosts, and *.firebaseapp.com /
// *.web.app auth handlers. Organic redirects are NOT routed through here.
export function hostAllowed(url: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const ok = (allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);
  if (allowedHosts.some(ok)) return true;
  if (DEFAULT_AUTH_HOSTS.some(ok)) return true;
  if (host.endsWith(".firebaseapp.com") || host.endsWith(".web.app")) return true;
  return false;
}

function visibleModeMarkers(pageText: string): string[] {
  const text = pageText.replace(/\s+/g, " ").trim();
  const markers: string[] = [];
  if (
    /\b(?:test|sandbox)\s+(?:mode|usage|environment|workspace)\b/i.test(text) ||
    /\b(?:mode|environment|workspace)\s*[:=-]?\s*(?:test|sandbox)\b/i.test(text)
  ) {
    markers.push("test/sandbox mode");
  }
  if (
    /\b(?:live|production)\s+mode\b/i.test(text) ||
    /\b(?:mode|environment|workspace)\s*[:=-]?\s*(?:live|production)\b/i.test(text)
  ) {
    markers.push("live/production mode");
  }
  return markers;
}

function appSurfaceMarkers(pageText: string): string[] {
  const text = pageText.replace(/\s+/g, " ").trim();
  const markers: string[] = [];
  const defs: Array<[string, RegExp]> = [
    ["dashboard", /\bdashboard\b/i],
    ["products", /\bproducts?\b/i],
    ["customers", /\bcustomers?\b/i],
    ["payments", /\bpayments?\b/i],
    ["developers", /\bdevelopers?\b/i],
    ["api keys", /\bapi\s+keys?\b/i],
    ["settings", /\bsettings\b/i],
    ["workspace", /\bworkspace\b/i],
    ["project", /\bproject\b/i],
    ["billing", /\bbilling\b/i],
    ["usage", /\busage\b/i],
    ["team", /\bteam\b/i],
  ];
  for (const [name, re] of defs) {
    if (re.test(text)) markers.push(name);
  }
  for (const mode of visibleModeMarkers(text)) markers.push(mode);
  return [...new Set(markers)].slice(0, 8);
}

function authenticatedAppSurfaceMarkers(pageText: string): string[] {
  const markers = appSurfaceMarkers(pageText);
  const modeMarkers = visibleModeMarkers(pageText);
  if (modeMarkers.length > 0) return markers;
  return markers.length >= 2 ? markers : [];
}

function hasAccountSetupOverlay(pageText: string): boolean {
  const text = pageText.replace(/\s+/g, " ").trim();
  return (
    /\b(?:finish|complete|set up|setup)\s+(?:creating\s+|setting\s+up\s+)?(?:your\s+)?(?:account|profile|organization|workspace|business)\b/i.test(
      text,
    ) ||
    /\bcreate\s+(?:your\s+)?account\b/i.test(text) ||
    /\btell us about (?:yourself|your business|your organization|your company)\b/i.test(text)
  );
}

function isAccountSetupActionTarget(target: string): boolean {
  return /\b(?:create|finish|complete|set up|setup)\s+(?:your\s+)?(?:account|profile|organization|workspace|business)\b/i.test(
    target,
  );
}

function isBillingObjectActionTarget(target: string): boolean {
  return (
    /\b(create|save|add|finish)\b/i.test(target) &&
    /\b(product|price|pricing|subscription|billing|payment|invoice|checkout)\b/i.test(target)
  );
}

export function provisionPerceptionGuidance(pageText: string): string | undefined {
  const appMarkers = authenticatedAppSurfaceMarkers(pageText);
  const modeMarkers = visibleModeMarkers(pageText);
  const setupOverlay = hasAccountSetupOverlay(pageText);
  const parts: string[] = [];

  if (modeMarkers.length > 0) {
    parts.push(`Mode marker visible: ${modeMarkers.join(", ")}.`);
  } else if (appMarkers.length > 0 || setupOverlay) {
    parts.push(
      "No test/sandbox/live mode marker is visible. For mode-sensitive tasks, do not create or save objects until the required mode is visible.",
    );
  }

  if (setupOverlay && appMarkers.length > 0) {
    parts.push(
      `Screen perception: account/setup overlay text is present while authenticated app markers are also visible (${appMarkers.join(", ")}). This often means a foreground onboarding modal is blocking an already-authenticated app, not that OAuth failed. Do not restart OAuth or navigate to login solely because the overlay says create/finish account; either satisfy the minimal required setup once, or use same-origin app navigation/direct dashboard URLs toward the user's goal.`,
    );
  } else if (appMarkers.length > 0) {
    parts.push(
      `Screen perception: authenticated app markers are visible (${appMarkers.join(", ")}). Prefer app navigation over restarting OAuth unless the current URL is clearly an identity-provider login page.`,
    );
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function shouldBlockUnsafeProvisionAction(
  pageText: string,
  action: ProvisionAction,
): string | null {
  if (!("target" in action)) return null;
  const appMarkers = authenticatedAppSurfaceMarkers(pageText);
  if (
    appMarkers.length > 0 &&
    isAccountSetupActionTarget(action.target) &&
    hasAccountSetupOverlay(pageText)
  ) {
    return (
      `Perception guard: "${action.target}" looks like an account/setup overlay action, ` +
      `but authenticated app markers are already visible (${appMarkers.join(", ")}). ` +
      `Do not retry OAuth or repeatedly press this overlay; use app navigation/direct ` +
      `same-origin URLs or complete only the minimal required setup.`
    );
  }
  if (
    isBillingObjectActionTarget(action.target) &&
    /\b(?:live|production)\s+mode\b/i.test(pageText)
  ) {
    return (
      `Mode safety guard: "${action.target}" can create or save billing objects, ` +
      `but live/production mode is visible. Switch to the required test/sandbox mode before acting.`
    );
  }
  return null;
}

export function buildScreenOutline(
  elements: readonly InteractiveElement[],
  pageText: string,
): ScreenOutline | undefined {
  if (elements.length === 0) return undefined;
  const byRegion = new Map<string, ScreenRegion>();
  for (const el of elements) {
    const id = el.container ?? "body:root";
    const role = id.split(":")[0] ?? "region";
    const existing = byRegion.get(id);
    const region: ScreenRegion = existing ?? {
      id,
      role,
      topmost: false,
      occluded_by: null,
      children: [],
    };
    if (el.topmost === true) {
      region.topmost = true;
      region.occluded_by = null;
    } else if (
      region.occluded_by === null &&
      el.occludedBy !== null &&
      el.occludedBy !== undefined
    ) {
      region.occluded_by = el.occludedBy;
    }
    if (region.children.length < 10) {
      region.children.push({
        ref: el.screenPath ?? elementRef(el),
        role: el.role,
        text: elementRef(el),
        href: el.href ?? null,
        topmost: el.topmost ?? null,
        occluded_by: el.occludedBy ?? null,
      });
    }
    byRegion.set(id, region);
  }
  const regions = [...byRegion.values()].slice(0, 12);
  const foreground =
    regions.find((r) => r.topmost && r.role === "dialog")?.id ??
    regions.find((r) => r.topmost)?.id ??
    null;
  return {
    foreground,
    mode_markers: visibleModeMarkers(pageText),
    regions,
  };
}

function roleForAccessibility(el: InteractiveElement): string {
  if (el.role !== null && el.role.length > 0) return el.role;
  if (el.tag === "a") return "link";
  if (el.tag === "input") return el.type ?? "textbox";
  return el.tag;
}

export function buildAccessibilitySnapshot(
  elements: readonly InteractiveElement[],
  generation: number,
  limit = 12000,
): AccessibilitySnapshot | undefined {
  if (elements.length === 0) return undefined;
  const refs = provisionElementRefs(elements, generation);
  const byRegion = new Map<string, InteractiveElement[]>();
  for (const el of elements) {
    const region = el.container ?? "body:root";
    const group = byRegion.get(region) ?? [];
    group.push(el);
    byRegion.set(region, group);
  }

  const entries = [...byRegion.entries()];
  const structurallyTruncated =
    entries.length > 24 || entries.some(([, group]) => group.length > 16);
  const lines: string[] = ["RootWebArea"];
  for (const [region, group] of entries.slice(0, 24)) {
    lines.push(`  region "${region}"`);
    for (const el of group.slice(0, 16)) {
      const label = elementRef(el).replace(/"/g, '\\"');
      const role = roleForAccessibility(el);
      const flags = [
        el.value !== undefined && el.value !== null ? `value="${el.value.slice(0, 60)}"` : null,
        el.checked !== undefined && el.checked !== null ? `checked=${el.checked}` : null,
        el.href !== undefined && el.href !== null ? `href="${el.href.slice(0, 120)}"` : null,
        el.topmost === false ? `occluded_by="${el.occludedBy ?? "unknown"}"` : null,
      ].filter((v): v is string => v !== null);
      lines.push(
        `    ${role} "${label}" ref=${refs.get(el) ?? provisionElementRef(el, generation)}` +
          (flags.length > 0 ? ` ${flags.join(" ")}` : ""),
      );
    }
  }
  if (structurallyTruncated) {
    lines.push("  ... (truncated, more interactive elements omitted)");
  }

  const tree = lines.join("\n");
  if (tree.length <= limit) {
    return {
      tree,
      refs: elements.length,
      truncated: structurallyTruncated,
      total_chars: tree.length,
      source: "interactive_dom",
    };
  }
  const cut = tree.lastIndexOf("\n", limit);
  const text = tree.slice(0, cut > 0 ? cut : limit);
  return {
    tree: text,
    refs: elements.length,
    truncated: true,
    total_chars: tree.length,
    source: "interactive_dom",
  };
}

function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function baseDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  return parts.slice(-2).join(".");
}

function widenAllowedHostsFromCurrentUrl(session: Session): void {
  const host = registrableHost(session.browser.currentUrl());
  if (host === null || session.allowedHosts.includes(host)) return;
  const currentBase = baseDomain(host);
  if (session.allowedHosts.some((allowed) => baseDomain(allowed) === currentBase)) {
    session.allowedHosts.push(host);
    audit(session.id, "scope_widen", { host, allowed_hosts: session.allowedHosts });
  }
}

// ── session lifecycle ──

export interface StartOptions {
  serviceUrl: string;
  // Persistent Chrome profile (the user's seeded session). Defaults to the
  // controller's CHROME_PROFILE_DIR.
  profileDir?: string;
  proxyUrl?: string;
  // Extra hosts to widen domain-scope (e.g. a known custom IdP/mail host).
  extraAllowedHosts?: readonly string[];
  // Registry route guidance the tool layer resolved (renderSkillHint). Attached
  // to the start observation so the agent reads the map before driving.
  hint?: string;
}

export async function startProvisionSession(opts: StartOptions): Promise<Observation> {
  const id = randomUUID();
  const browser = new BrowserController({
    ...(opts.profileDir !== undefined ? { profileDir: opts.profileDir } : {}),
    ...(opts.proxyUrl !== undefined ? { proxyUrl: opts.proxyUrl } : {}),
  });
  await browser.start();
  const targetHost = registrableHost(opts.serviceUrl);
  const allowedHosts = [
    ...(targetHost !== null ? [targetHost] : []),
    ...(opts.extraAllowedHosts ?? []),
  ];
  const session: Session = { id, browser, allowedHosts, generation: 0, lastElements: [] };
  sessions.set(id, session);
  audit(id, "start", {
    service_url: opts.serviceUrl,
    allowed_hosts: allowedHosts,
    has_hint: opts.hint !== undefined,
  });
  await browser.goto(opts.serviceUrl);
  const observation = await observeSession(session);
  // Tell the agent which provider the user actually has a live session for
  // (Google-preferred) — the bot knows from the profile cookies, so the agent
  // doesn't have to guess. Composed with the skill route hint (if any).
  const liveProviders = await browser.detectSessionProviders().catch(() => [] as OAuthProviderId[]);
  const hintParts = [
    loginSessionGuidance(liveProviders),
    ...(opts.hint !== undefined ? [opts.hint] : []),
  ];
  return { ...observation, hint: hintParts.join("\n") };
}

export async function observe(sessionId: string): Promise<Observation> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return await observeSession(session);
}

export function observedHostsForSession(sessionId: string): string[] {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  widenAllowedHostsFromCurrentUrl(session);
  return [...new Set(session.allowedHosts)];
}

async function observeSession(session: Session): Promise<Observation> {
  session.browser.recoverActivePage();
  widenAllowedHostsFromCurrentUrl(session);
  session.generation += 1;
  const generation = session.generation;
  const elements = await session.browser.extractInteractiveElements();
  session.lastElements = elements;
  const text = await session.browser.extractVisibleText();
  const normalizedText = text.replace(/\s+/g, " ").trim().slice(0, 4000);
  const guidance = provisionPerceptionGuidance(normalizedText);
  const screen = buildScreenOutline(elements, normalizedText);
  const accessibility = buildAccessibilitySnapshot(elements, generation);
  const refs = provisionElementRefs(elements, generation);
  return {
    session_id: session.id,
    url: session.browser.currentUrl(),
    text: normalizedText,
    ...(guidance !== undefined ? { guidance } : {}),
    ...(screen !== undefined ? { screen } : {}),
    ...(accessibility !== undefined ? { accessibility } : {}),
    elements: elements.map((el) => ({
      ref: refs.get(el) ?? provisionElementRef(el, generation),
      label: elementRef(el),
      tag: el.tag,
      role: el.role,
      type: el.type,
      value: el.value ?? null,
      checked: el.checked ?? null,
      href: el.href ?? null,
      testId: el.testId ?? null,
      path: el.screenPath ?? null,
      container: el.container ?? null,
      topmost: el.topmost ?? null,
      occluded_by: el.occludedBy ?? null,
    })),
  };
}

export async function act(sessionId: string, action: ProvisionAction): Promise<Observation> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;
  audit(sessionId, "act", {
    kind: action.kind,
    ...("target" in action ? { target: action.target } : {}),
    ...("url" in action ? { url: action.url } : {}),
  });

  switch (action.kind) {
    case "goto": {
      if (!hostAllowed(action.url, session.allowedHosts)) {
        throw new Error(
          `goto blocked by domain-scope: ${action.url} is outside the allowed hosts ` +
            `[${session.allowedHosts.join(", ")}] + auth providers`,
        );
      }
      await browser.goto(action.url);
      break;
    }
    case "press": {
      await browser.pressKey(action.key);
      break;
    }
    case "oauth_settle": {
      await browser.settleAfterOAuth();
      break;
    }
    case "click":
    case "js_click":
    case "type":
    case "oauth_click": {
      const blockReason = shouldBlockUnsafeProvisionAction(
        await browser.extractVisibleText(),
        action,
      );
      if (blockReason !== null) throw new Error(blockReason);
      // Re-resolve against FRESH elements every act — never trust a stale index.
      const fresh = await browser.extractInteractiveElements();
      session.lastElements = fresh;
      const el = resolveTarget(fresh, action.target, session.generation);
      if (el === null) {
        throw new Error(
          `no element matched target "${action.target}". Visible: ` +
            fresh
              .map((e) => `"${e.screenPath ?? elementRef(e)}"`)
              .slice(0, 20)
              .join(", "),
        );
      }
      if (action.kind === "click") await browser.click(el.selector);
      else if (action.kind === "js_click") await browser.clickViaJs(el.selector);
      else if (action.kind === "type") await browser.type(el.selector, action.text);
      else await browser.startOAuth(el.selector);
      if (action.kind !== "type") await settleAfterStateChange(browser);
      break;
    }
  }
  return await observeSession(session);
}

async function settleAfterStateChange(browser: BrowserController): Promise<void> {
  await settle(450);
  await browser.waitForInteractiveDom(1, 2_000).catch(() => undefined);
  for (let i = 0; i < 4; i += 1) {
    const text = await browser.extractVisibleText().catch(() => "");
    if (text.replace(/\s+/g, " ").trim().length > 0) return;
    await settle(300);
  }
}

// ── extraction (the `extract` thick tool) ──

export interface ExtractResult {
  session_id: string;
  url: string;
  // The deliverable: a primary `api_key` (or `api_key_truncated` when only a
  // masked display was reachable) plus any labeled/named credentials a
  // multi-cred service presents (e.g. cloud_name, api_secret).
  credentials: Record<string, string>;
  // How many labeled credential candidates the page presented — diagnostic so
  // the host can tell "found nothing" from "found masked values it couldn't read".
  candidate_count: number;
  // Set when extraction failed CLOSED: the page is a login wall / anti-bot
  // interstitial with no credential to give (Grok/X tombstone), so the extractor
  // refused to surface junk. The host should drive an interactive login or hand
  // back to the user rather than treat an empty result as "service issued none".
  blocked_reason?: string;
}

const normLabelKey = (label: string): string =>
  label
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase()
    .slice(0, 40);

// A real credential never looks like a code identifier. X's anti-bot tombstone
// ("JavaScript is not available…") leaked `loader.tweetUnavailableTombstoneHandler`
// (a JS function name) into the extractor, which wrote it to the vault as a key
// — a false-green. Reject any dotted member-access token (JWTs are the one
// legitimate dotted credential, guarded by their `eyJ` prefix).
export function looksLikeCodeIdentifier(s: string): boolean {
  const t = s.trim();
  if (t.startsWith("eyJ")) return false;
  return /[A-Za-z]\.[A-Za-z]/.test(t);
}

function looksLikeCredentialValue(value: string): boolean {
  const v = value.trim();
  if (v.length < 12) return false;
  if (looksLikeCodeIdentifier(v)) return false;
  if (isCredentialNoise(v)) return false;
  return (
    findCredentialTokens(v).includes(v) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}

function isCredentialNoise(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return true;
  if (/^v?\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(v)) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (/^trusty-squire-dogfood-\d{8}$/i.test(v)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}=?$/.test(v)) return true;
  if (/^key_[A-Za-z0-9]{16,}$/i.test(v)) return true;
  if (v.includes("…") || v.includes("...")) return true;
  return false;
}

// A credentials page that is actually a login wall / anti-bot interstitial has
// no key to give — every token on it (CSRF cookie, asset hash, guest id) is
// junk. Grok is the standing case: x.ai routes signup through X (Twitter) OAuth,
// and X serves headless Chromium its "JavaScript is not available" tombstone, so
// the extractor would otherwise scrape session tokens and hand one back as a
// false-green key. Detect that state and fail CLOSED — return no credential plus
// an explicit reason the host agent can act on (drive an interactive login),
// rather than surfacing a bogus value. The phrases below are the load-bearing
// markers of X's tombstone + the four anti-bot vendors waitForFormReady knows.
const LOGIN_WALL_MARKERS: readonly RegExp[] = [
  /javascript is not available/i,
  /enable javascript/i,
  /verifying you are human/i,
  /checking your browser/i,
  /just a moment/i,
  /review the security of your connection/i,
  /unusual (traffic|activity) (from|on)/i,
];
export function detectExtractionBlock(pageText: string): string | null {
  // Require a SHORT page — a real keys page that merely mentions "enable
  // JavaScript" in a footer is not a wall. A tombstone/interstitial is sparse.
  if (pageText.trim().length > 600) return null;
  for (const re of LOGIN_WALL_MARKERS) {
    if (re.test(pageText)) {
      return "login_wall: the page is an anti-bot/login interstitial (no credential present) — drive an interactive login or hand back to the user";
    }
  }
  return null;
}

// Collect every distinct credential-SHAPED token in a blob of page text:
// a short prefix + separator + a long body that carries at least one digit
// (vsk_sandbox_write_…, xai-…, sk-lw-…, re_…). Used to surface the SECOND key a
// multi-credential service shows (e.g. VouchFlow's sandbox read alongside write)
// that the single-key extraction.ts policy stops short of. The `[_-]` and
// has-digit requirements exclude the dotted-function-name false positive.
const CRED_TOKEN_RE = /\b[A-Za-z][A-Za-z0-9]{1,9}[_-][A-Za-z0-9][A-Za-z0-9_-]{12,}\b/g;
export function findCredentialTokens(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CRED_TOKEN_RE)) {
    const t = m[0];
    if (seen.has(t)) continue;
    if (t.length < 16) continue;
    if (!/[0-9]/.test(t)) continue; // real keys carry digits; dictionary words don't
    if (/^[A-Z][A-Z0-9_]*$/.test(t)) continue; // env-var name
    if (!looksLikeCredentialToken(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function looksLikeCredentialToken(token: string): boolean {
  if (token.includes("_")) return true;
  return /^(?:api|key|pk|re|rk|sk|xai|ghp|pat|vsk)-/i.test(token);
}

function firstTokenMatching(haystack: string, re: RegExp): string | null {
  const match = haystack.match(re);
  return match?.[0] ?? null;
}

export function sanitizeExtractedCredentials(
  credentials: Record<string, string>,
  url: string,
  haystack = Object.values(credentials).join("\n"),
): Record<string, string> {
  const host = registrableHost(url) ?? "";
  const normalized: Record<string, string> = {};

  if (host === "cloud.langfuse.com") {
    const secret = firstTokenMatching(haystack, /\bsk-lf-[0-9a-f-]{20,}\b/i);
    const pub = firstTokenMatching(haystack, /\bpk-lf-[0-9a-f-]{20,}\b/i);
    if (secret !== null) {
      normalized.langfuse_secret_key = secret;
      normalized.api_key = secret;
    }
    if (pub !== null) normalized.langfuse_public_key = pub;
    return normalized;
  }

  if (host.endsWith(".neon.tech")) {
    const token = firstTokenMatching(haystack, /\bnapi_[A-Za-z0-9_-]{24,}\b/);
    if (token !== null) {
      normalized.api_token = token;
      normalized.api_key = token;
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(credentials)) {
    const k = normLabelKey(key);
    if (k === "refcode" || k === "referral_code") continue;
    if (isCredentialNoise(value)) continue;
    if ((k === "key" || k === "api_key") && !looksLikeCredentialValue(value)) continue;
    if (host === "api.together.ai" && /^key_[A-Za-z0-9]{16,}$/i.test(value.trim())) continue;
    normalized[key] = value;
  }
  return normalized;
}

export function classifyVouchflowCredentials(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of findCredentialTokens(text)) {
    if (/^vsk_sandbox_read_/i.test(tok) && out.sandbox_read_key === undefined) {
      out.sandbox_read_key = tok;
    } else if (/^vsk_sandbox_/i.test(tok) && out.sandbox_write_key === undefined) {
      out.sandbox_write_key = tok;
    } else if (/^vsk_live_read_/i.test(tok) && out.live_read_key === undefined) {
      out.live_read_key = tok;
    } else if (/^vsk_live_/i.test(tok) && out.live_write_key === undefined) {
      out.live_write_key = tok;
    }
  }
  return out;
}

// Reveal masked keys, then classify every on-page string source through the
// SAME exported regex policy the bot uses (extractApiKeyFromText +
// isTruncatedCapture + extraction.ts accumulation). Reuses the substrate —
// no new credential regexes.
export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;

  // The masked-display trap: click reveal/show toggles before reading.
  await browser.revealMaskedCredentials();

  const labeled = await browser.extractLabeledCredentialCandidates();
  const inputs = await browser.extractAllInputValues();
  const nearCopy = await browser.extractCredentialsNearCopyButtons();
  const text = await browser.extractVisibleText();

  // Fail CLOSED on a login wall / anti-bot interstitial: scraping it yields only
  // session/CSRF/asset tokens, and handing one back is a false-green. Refuse,
  // and tell the host why so it can drive an interactive login instead.
  const blocked = detectExtractionBlock(text);
  if (blocked !== null) {
    audit(sessionId, "extract", { found: false, blocked_reason: blocked });
    return {
      session_id: sessionId,
      url: browser.currentUrl(),
      credentials: {},
      candidate_count: 0,
      blocked_reason: blocked,
    };
  }

  // Copy-only key surfaces (e.g. LangWatch's /settings/api-keys) never render
  // the value into the DOM — it goes to the clipboard on a "Copy" click. Read
  // it (clipboard-read is granted at context creation).
  const clip = await browser.readClipboard().catch(() => "");

  // Primary api_key: first FULL hit wins; a truncated/masked hit is the fallback.
  let state = initialExtractionState();
  const sources: string[] = [...labeled.map((c) => c.value), ...inputs, ...nearCopy, clip, text];
  const haystack = sources.join("\n");
  for (const src of sources) {
    if (hasFullHit(state)) break;
    const key = extractApiKeyFromText(src);
    if (key === null) continue;
    // Reject an env-var NAME mistaken for a key — a "LANGWATCH_API_KEY="
    // display (the SDK snippet shows `LANGWATCH_API_KEY=sk-lw-…`) would
    // otherwise win first-full and mask the real token. Skip it so scanning
    // reaches the actual secret further down the source list.
    if (/^[A-Z][A-Z0-9_]{2,}=?$/.test(key.trim())) continue;
    if (isCredentialNoise(key)) continue;
    // Reject too-short non-secrets (UI noise like "Ctrl+K"). Real API keys are
    // long; a sub-12-char "key" is a false positive, never a credential.
    if (key.trim().length < 12) continue;
    // Reject a code identifier scraped off a page (the X-tombstone false-green).
    if (looksLikeCodeIdentifier(key)) continue;
    const cls: CandidateClass = isTruncatedCapture(src, key)
      ? { kind: "truncated", value: key }
      : { kind: "full", value: key };
    state = accumulateCandidate(state, cls);
  }

  // Named credentials for multi-cred services (skip still-masked values and
  // env-var NAME displays — "LANGWATCH_API_KEY=" is the SDK-snippet prefix, not
  // a credential).
  const named: Record<string, string> = {};
  for (const c of labeled) {
    if (c.label === null || c.isMasked) continue;
    if (isCredentialNoise(c.value)) continue;
    if (looksLikeCodeIdentifier(c.value)) continue;
    const k = normLabelKey(c.label);
    if (k.length > 0 && !(k in named)) named[k] = c.value;
  }

  // resolveExtraction (the regex-found primary key) wins over a same-named
  // labeled candidate, so a "API Key" label carrying the env-var snippet can
  // never clobber the real `api_key`.
  const credentials: Record<string, string> = {
    ...named,
    ...classifyVouchflowCredentials(haystack),
    ...resolveExtraction(state),
  };

  // Multi-credential: a service may present several keys of the same shape
  // (VouchFlow shows sandbox write AND read). The single-key extraction.ts
  // policy stops at the first; collect every distinct credential-shaped token
  // and surface the ones the primary missed as api_key_2, api_key_3, …
  const have = new Set(Object.values(credentials));
  let n = 1;
  for (const tok of findCredentialTokens(haystack)) {
    if (have.has(tok)) continue;
    if (n >= 8) break; // cap extras so page noise can't flood the result
    have.add(tok);
    n += 1;
    credentials[`api_key_${n}`] = tok;
  }
  const sanitized = sanitizeExtractedCredentials(credentials, browser.currentUrl(), haystack);
  audit(sessionId, "extract", {
    found: Object.keys(sanitized).length > 0,
    candidate_count: labeled.length,
  });
  return {
    session_id: sessionId,
    url: browser.currentUrl(),
    credentials: sanitized,
    candidate_count: labeled.length,
  };
}

// ── captcha gate (thick tool) ──

export interface CaptchaGateResult {
  session_id: string;
  found: boolean;
  variant: string;
  // True when no challenge is rendered after the wait — either there was none,
  // or the behavior-sim/IP score cleared an invisible widget. False means a
  // visible challenge is still up (the host should surface captcha_blocked).
  settled: boolean;
}

// Detect a captcha and wait for it to clear. Behavior-sim (humanized clicks +
// typing) during the drive already scores invisible Turnstile/reCAPTCHA-v3; for
// a visible checkbox the host clicks it via provision_act, then calls this to
// wait for the token. Reuses the substrate's detector + settle poll.
export async function captchaGate(sessionId: string): Promise<CaptchaGateResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const det = await session.browser.detectCaptchaVariant();
  const found = det.variant !== "unknown" || det.challengeRendered;
  if (!found) {
    audit(sessionId, "captcha_gate", { found: false });
    return { session_id: sessionId, found: false, variant: "none", settled: true };
  }
  const settled = await session.browser.waitForCaptchaChallengeToSettle(15_000);
  audit(sessionId, "captcha_gate", { found: true, variant: det.variant, settled });
  return { session_id: sessionId, found: true, variant: det.variant, settled };
}

// ── email verification (thick tool — user-inbox-via-browser) ──

export interface VerificationResult {
  session_id: string;
  found: boolean;
  // A short numeric OTP if one appears in the matching mail, else null.
  code: string | null;
  // A verification/confirm link if present, else null. The host decides whether
  // to goto it (it is within the target's own domain → already domain-scoped).
  link: string | null;
}

export interface AwaitVerificationOptions {
  // Narrow the Gmail search to the sending service, e.g. "resend.com".
  sender?: string;
}

// Pure verification parser (exported for unit tests). Extracts a {code, link}
// from mail text + its links. A 4-8 digit code is PREFERRED when it sits near
// an OTP keyword ("code"/"verification"/"otp"/"passcode"), so a date or order
// number elsewhere in the mail doesn't win; falls back to the first standalone
// 4-8 digit run. The link uses the bot's pickVerificationLink heuristic.
const OTP_ANY_RE = /(?:^|[^0-9])(\d{4,8})(?:[^0-9]|$)/g;
const OTP_KEYWORD_RE =
  /(?:code|verification|verify|otp|passcode|one[- ]time)\D{0,40}?(\d{4,8})|(\d{4,8})\D{0,8}?(?:code|verification|verify|otp|passcode)/i;

export function parseVerification(
  text: string,
  links: readonly string[],
): { code: string | null; link: string | null } {
  const link = pickVerificationLink([...links]);
  const kw = OTP_KEYWORD_RE.exec(text);
  let code: string | null = null;
  if (kw !== null) {
    code = kw[1] ?? kw[2] ?? null;
  } else {
    const m = OTP_ANY_RE.exec(text);
    code = m !== null ? (m[1] ?? null) : null;
  }
  return { code, link };
}

export async function awaitVerification(
  sessionId: string,
  opts: AwaitVerificationOptions = {},
): Promise<VerificationResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;

  const filters = [
    opts.sender !== undefined && opts.sender.length > 0 ? `from:${opts.sender}` : "",
    "newer_than:1d",
    "(verify OR verification OR confirm OR code OR otp OR password)",
  ].filter((s) => s.length > 0);
  const query = filters.join(" ");
  // Internal navigation (not an agent goto) — sanctioned read of the user's mail.
  await browser.goto(`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`);

  // Poll briefly for the result list / opened mail to render text.
  let text = "";
  for (let i = 0; i < 6; i++) {
    text = await browser.extractVisibleText();
    if (text.length > 200) break;
    await browser.waitForCaptchaChallengeToSettle(1200, 0).catch(() => false);
  }

  const els = await browser.extractInteractiveElements();
  const links = els
    .map((e) => e.href)
    .filter((h): h is string => typeof h === "string" && h.length > 0);
  const { code, link } = parseVerification(text, links);
  const found = code !== null || link !== null;
  audit(sessionId, "await_verification", {
    sender: opts.sender ?? null,
    has_code: code !== null,
    has_link: link !== null,
  });
  return { session_id: sessionId, found, code, link };
}

export interface FinishResult {
  session_id: string;
  url: string;
  closed: true;
}

export async function finishProvisionSession(sessionId: string): Promise<FinishResult> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const url = session.browser.currentUrl();
  audit(sessionId, "finish", { url });
  await session.browser.close();
  sessions.delete(sessionId);
  return { session_id: sessionId, url, closed: true };
}

// Test/teardown helper — close every live session (used by the dev shim on exit).
export async function closeAllProvisionSessions(): Promise<void> {
  for (const id of [...sessions.keys()]) {
    try {
      await finishProvisionSession(id);
    } catch {
      /* best-effort */
    }
  }
}

export function activeSessionCount(): number {
  return sessions.size;
}
