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

import { randomUUID } from "node:crypto";
import { BrowserController, type InteractiveElement } from "./browser.js";
import { extractApiKeyFromText, isTruncatedCapture, pickVerificationLink } from "./agent.js";
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
  // The stable handle the host targets by — the element's best human label.
  // The host echoes this back as an action `target`; resolveTarget re-matches
  // it against freshly-extracted elements (re-resolution), so it survives
  // re-renders that would invalidate any positional index.
  ref: string;
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
}

export interface Observation {
  session_id: string;
  url: string;
  // Layout-aware page prose (innerText) so the agent can read passages,
  // questions, masked-key hints, etc. Capped to keep tool payloads bounded.
  text: string;
  elements: ObservedElement[];
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
  allowedHosts: readonly string[];
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

// Resolve a host-supplied target string to one live element. Matching is by
// label text (+ role tiebreak), scored exact > startsWith > contains. Returns
// null when nothing matches — the caller surfaces that rather than guessing.
export function resolveTarget(
  elements: readonly InteractiveElement[],
  target: string,
): InteractiveElement | null {
  const want = norm(target);
  if (want.length === 0) return null;
  let best: { el: InteractiveElement; score: number } | null = null;
  for (const el of elements) {
    const label = norm(elementRef(el));
    let score = 0;
    if (label === want) score = 100;
    else if (label.startsWith(want)) score = 70;
    else if (label.includes(want)) score = 50;
    else if (want.includes(label) && label.length >= 2) score = 30;
    if (score === 0) continue;
    // Prefer shorter labels at equal score (a more specific match).
    const adjusted = score - label.length * 0.01;
    if (best === null || adjusted > best.score) best = { el, score: adjusted };
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
  const ok = (allowed: string): boolean =>
    host === allowed || host.endsWith(`.${allowed}`);
  if (allowedHosts.some(ok)) return true;
  if (DEFAULT_AUTH_HOSTS.some(ok)) return true;
  if (host.endsWith(".firebaseapp.com") || host.endsWith(".web.app")) return true;
  return false;
}

function registrableHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
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
}

export async function startProvisionSession(
  opts: StartOptions,
): Promise<Observation> {
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
  const session: Session = { id, browser, allowedHosts, lastElements: [] };
  sessions.set(id, session);
  audit(id, "start", { service_url: opts.serviceUrl, allowed_hosts: allowedHosts });
  await browser.goto(opts.serviceUrl);
  return await observeSession(session);
}

export async function observe(sessionId: string): Promise<Observation> {
  const session = sessions.get(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  return await observeSession(session);
}

async function observeSession(session: Session): Promise<Observation> {
  const elements = await session.browser.extractInteractiveElements();
  session.lastElements = elements;
  const text = await session.browser.extractVisibleText();
  return {
    session_id: session.id,
    url: session.browser.currentUrl(),
    text: text.replace(/\s+/g, " ").trim().slice(0, 4000),
    elements: elements.map((el) => ({
      ref: elementRef(el),
      tag: el.tag,
      role: el.role,
      type: el.type,
      value: el.value ?? null,
      checked: el.checked ?? null,
      href: el.href ?? null,
      testId: el.testId ?? null,
    })),
  };
}

export async function act(
  sessionId: string,
  action: ProvisionAction,
): Promise<Observation> {
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
      // Re-resolve against FRESH elements every act — never trust a stale index.
      const fresh = await browser.extractInteractiveElements();
      session.lastElements = fresh;
      const el = resolveTarget(fresh, action.target);
      if (el === null) {
        throw new Error(
          `no element matched target "${action.target}". Visible: ` +
            fresh.map((e) => `"${elementRef(e)}"`).slice(0, 20).join(", "),
        );
      }
      if (action.kind === "click") await browser.click(el.selector);
      else if (action.kind === "js_click") await browser.clickViaJs(el.selector);
      else if (action.kind === "type") await browser.type(el.selector, action.text);
      else await browser.startOAuth(el.selector);
      // Brief settle so a React state update (a card selection, a form-state
      // commit) lands before the next observe — the radio-card "needed a
      // re-observe" symptom from the live run.
      if (action.kind !== "type") await settle(450);
      break;
    }
  }
  return await observeSession(session);
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
    seen.add(t);
    out.push(t);
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
  // Copy-only key surfaces (e.g. LangWatch's /settings/api-keys) never render
  // the value into the DOM — it goes to the clipboard on a "Copy" click. Read
  // it (clipboard-read is granted at context creation).
  const clip = await browser.readClipboard().catch(() => "");

  // Primary api_key: first FULL hit wins; a truncated/masked hit is the fallback.
  let state = initialExtractionState();
  const sources: string[] = [...labeled.map((c) => c.value), ...inputs, ...nearCopy, clip, text];
  for (const src of sources) {
    if (hasFullHit(state)) break;
    const key = extractApiKeyFromText(src);
    if (key === null) continue;
    // Reject an env-var NAME mistaken for a key — a "LANGWATCH_API_KEY="
    // display (the SDK snippet shows `LANGWATCH_API_KEY=sk-lw-…`) would
    // otherwise win first-full and mask the real token. Skip it so scanning
    // reaches the actual secret further down the source list.
    if (/^[A-Z][A-Z0-9_]{2,}=?$/.test(key.trim())) continue;
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
    if (/^[A-Z][A-Z0-9_]{2,}=?$/.test(c.value.trim())) continue;
    if (looksLikeCodeIdentifier(c.value)) continue;
    const k = normLabelKey(c.label);
    if (k.length > 0 && !(k in named)) named[k] = c.value;
  }

  // resolveExtraction (the regex-found primary key) wins over a same-named
  // labeled candidate, so a "API Key" label carrying the env-var snippet can
  // never clobber the real `api_key`.
  const credentials: Record<string, string> = { ...named, ...resolveExtraction(state) };

  // Multi-credential: a service may present several keys of the same shape
  // (VouchFlow shows sandbox write AND read). The single-key extraction.ts
  // policy stops at the first; collect every distinct credential-shaped token
  // and surface the ones the primary missed as api_key_2, api_key_3, …
  const haystack = [...labeled.map((c) => c.value), ...inputs, ...nearCopy, clip, text].join("\n");
  const have = new Set(Object.values(credentials));
  let n = 1;
  for (const tok of findCredentialTokens(haystack)) {
    if (have.has(tok)) continue;
    if (n >= 8) break; // cap extras so page noise can't flood the result
    have.add(tok);
    n += 1;
    credentials[`api_key_${n}`] = tok;
  }
  audit(sessionId, "extract", {
    found: Object.keys(credentials).length > 0,
    candidate_count: labeled.length,
  });
  return {
    session_id: sessionId,
    url: browser.currentUrl(),
    credentials,
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

export async function finishProvisionSession(
  sessionId: string,
): Promise<FinishResult> {
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
