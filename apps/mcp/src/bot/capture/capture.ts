// Capture-side code, extracted verbatim from provision-session.ts
// (layer-contracts PR 11 — the capture module split). Owns the extract/capture
// thick-tool cluster: labeled-candidate sanitization and Vouchflow
// classification, the shadow-piercing capture walk, capture-source resolution
// (pre- and post-action), and the session-facing extractCredentials /
// captureCredentialSource / probeCaptureSource. No behaviour change.
// provision-session imports the session-facing entry points back and keeps
// re-exporting the tool layer's import surface; this module imports only from
// the rest of the tree, never from provision-session.

import type { ElementHandle, Page } from "playwright";
import type { CaptureSource } from "../credential-capture.js";
import { extractApiKeyFromText, isTruncatedCapture } from "../credential-text.js";
import {
  looksLikeCodeIdentifier,
  looksLikeCredentialValue,
  isCredentialNoise,
  findCredentialTokens,
  keyFamilyPrefix,
  pickRelaxedNearCopyCredential,
} from "../credential-shape.js";
import {
  initialExtractionState,
  accumulateCandidate,
  hasFullHit,
  resolveExtraction,
  type CandidateClass,
} from "../extraction.js";
import type { Session } from "../session/model.js";
import { registrableHost } from "../session/hosts.js";
import { audit, sessionForCall } from "../session/lifecycle.js";
import { invalidateCompactV2Snapshot, operationPageForSession } from "../observe/observe.js";
import { settleAfterStateChange } from "../act/act.js";

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
  // Labels of credential-shaped values that are STILL masked after the reveal
  // pass. Non-empty means the capture is incomplete: a sibling key was not
  // read, so a caller must not treat this as a successful extraction.
  masked_remaining?: string[];
}

const normLabelKey = (label: string): string =>
  label
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase()
    .slice(0, 40);

/** Labels of masked credential candidates that no readable value covers. A
 * masked display is only "remaining" when nothing readable was captured under
 * the same label: a page can show the created key in clear while still carrying
 * a masked copy — or a mask-shaped decoration — beside the same field name, and
 * the readable value is what decides completion. A genuinely unread sibling has
 * its own label (or none), so it stays. */
export function maskedCredentialLabels(
  candidates: readonly { label: string | null; isMasked: boolean; value?: string }[],
  readableKeys: readonly string[] = [],
): string[] {
  const readable = new Set<string>(readableKeys.map((key) => normLabelKey(key)));
  return [
    ...new Set(
      candidates
        .filter((candidate) => candidate.isMasked)
        .filter((candidate) => {
          if (candidate.label === null) return true;
          const sameLabel = candidates.filter(
            (other) =>
              !other.isMasked &&
              other.label !== null &&
              normLabelKey(other.label) === normLabelKey(candidate.label!),
          );
          if (candidate.value === undefined) {
            return sameLabel.length === 0 && !readable.has(normLabelKey(candidate.label));
          }
          if (sameLabel.length === 0) return true;
          const prefix = candidate.value?.split(/[•●⬤*…]/, 1)[0]?.replace(/\.+$/, "");
          if (prefix === undefined || prefix.length === 0) return false;
          return !sameLabel.some((other) => other.value?.startsWith(prefix));
        })
        .map((candidate) => candidate.label ?? "masked credential"),
    ),
  ];
}

function firstTokenMatching(haystack: string, re: RegExp): string | null {
  const match = haystack.match(re);
  return match?.[0] ?? null;
}

export function sanitizeExtractedCredentials(
  credentials: Record<string, string>,
  url: string,
  haystack = Object.values(credentials).join("\n"),
  acceptedNearCopyCredential: string | null = null,
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
    if (
      (k === "key" || k === "api_key" || k === "secret") &&
      value !== acceptedNearCopyCredential &&
      !looksLikeCredentialValue(value)
    )
      continue;
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
/** What a zero-match capture DID find, so the caller can pick a better source
 * on the next try: computed roles and accessible names only — never values. */
export interface CaptureFoundCandidate {
  role: string;
  name: string | null;
}

async function shadowPiercingCapture(
  page: Page,
  source: CaptureSource,
  handles: ElementHandle<Node>[],
  containerHandles: ElementHandle<Node>[],
): Promise<{ candidate_count: number; value?: string; found?: CaptureFoundCandidate[] }> {
  return await page.evaluate(
    ({ source: spec, nodes: sourceNodes, scopeNodes: containerNodes }) => {
      const captureElement = (node: Node): Element => {
        if (!(node instanceof Element) || !node.isConnected || node.ownerDocument !== document)
          throw new Error("capture source changed");
        return node;
      };
      // Playwright's role engine maps password inputs to textbox; ARIA gives
      // them no role, so they never satisfy a textbox request.
      const nodes = sourceNodes
        .map(captureElement)
        .filter(
          (el) =>
            !(
              "role" in spec &&
              spec.role === "textbox" &&
              el instanceof HTMLInputElement &&
              el.type === "password"
            ),
        );
      const scopeNodes = containerNodes.map(captureElement);
      const nativeShadowGet = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get;
      const shadowRootOf = (el: Element): ShadowRoot | null => {
        try {
          return nativeShadowGet?.call(el) ?? null;
        } catch {
          return null;
        }
      };

      const isVisible = (el: Element): boolean => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const s = window.getComputedStyle(el);
        return (
          s.display !== "none" && s.visibility !== "hidden" && parseFloat(s.opacity || "1") > 0.01
        );
      };

      // Walk the light DOM and every OPEN shadow root. Defensive against
      // detached/closed custom elements whose shadowRoot reads undefined at
      // runtime (the #59 redis-cloud crash pattern): skip such nodes.
      const elements: Element[] = [];
      const walk = (root: Document | ShadowRoot | null | undefined): void => {
        if (root == null || typeof root.querySelectorAll !== "function") return;
        for (const el of Array.from(root.querySelectorAll("*"))) {
          elements.push(el);
          walk(shadowRootOf(el));
        }
      };
      walk(document);

      const accessibleName = (el: Element): string => {
        const root = el.getRootNode() as Document | ShadowRoot;
        const labelledby = el.getAttribute("aria-labelledby");
        if (labelledby) {
          const text = labelledby
            .split(/\s+/)
            .map((id) => root.getElementById(id)?.textContent ?? "")
            .join(" ")
            .trim();
          if (text) return text;
        }
        const label = (el.getAttribute("aria-label") ?? "").trim();
        if (label) return label;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const text = Array.from(el.labels ?? [])
            .map((label) => label.textContent ?? "")
            .join(" ")
            .trim();
          if (text) return text;
        }
        const title = (el.getAttribute("title") ?? "").trim();
        if (title) return title;
        return "";
      };

      const ariaRole = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit;
        if (el instanceof HTMLInputElement) {
          const t = (el.getAttribute("type") ?? "text").toLowerCase();
          if (["text", "search", "tel", "url", "email"].includes(t) && el.list !== null)
            return "combobox";
          if (t === "search") return "searchbox";
          if (t === "text" || t === "tel" || t === "url" || t === "email") return "textbox";
          if (t === "number") return "spinbutton";
          if (t === "checkbox") return "checkbox";
          if (t === "radio") return "radio";
          if (t === "range") return "slider";
          return ""; // password/button/file/hidden/... carry no textbox role
        }
        if (el instanceof HTMLTextAreaElement) return "textbox";
        if (el instanceof HTMLSelectElement) return "combobox";
        if (el instanceof HTMLDialogElement && el.open) return "dialog";
        if (el.tagName === "CODE") return "code";
        const name = accessibleName(el);
        if (el.tagName === "SECTION" && name) return "region";
        if (el.tagName === "FORM" && name) return "form";
        return "";
      };

      // Shadow-inclusive containment: parentElement stops at the shadow
      // boundary, so climb from each node through its root's host.
      const within = (node: Element, scopeEl: Element | null): boolean => {
        if (scopeEl === null) return true;
        let cur: Element | null = node;
        while (cur !== null) {
          if (cur === scopeEl) return true;
          const root = cur.getRootNode();
          cur = cur.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        }
        return false;
      };

      const isAriaIncluded = (el: Element): boolean => {
        for (let current: Element | null = el; current; ) {
          if (current.getAttribute("aria-hidden") === "true") return false;
          const root = current.getRootNode();
          current =
            current.assignedSlot ??
            current.parentElement ??
            (root instanceof ShadowRoot ? root.host : null);
        }
        return true;
      };

      const readValue = (node: Element): string => {
        const value =
          node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
            ? node.value
            : node instanceof HTMLElement
              ? node.innerText
              : "";
        return value.length <= 8192 ? value.trim() : "";
      };

      const containerSpec = spec.container ?? null;
      const containers =
        scopeNodes.length > 0
          ? scopeNodes
          : containerSpec
            ? elements.filter(
                (el) =>
                  isVisible(el) &&
                  isAriaIncluded(el) &&
                  ariaRole(el) === containerSpec.role &&
                  (containerSpec.name === undefined || accessibleName(el) === containerSpec.name),
              )
            : [];
      const inScope = (el: Element): boolean =>
        containerSpec === null || containers.some((container) => within(el, container));

      const foundReport = (): CaptureFoundCandidate[] => {
        const out: CaptureFoundCandidate[] = [];
        for (const el of elements) {
          if (out.length >= 12) break;
          if (!isVisible(el)) continue;
          const role = ariaRole(el);
          const tag = el.tagName;
          const named =
            el.getAttribute("aria-label") !== null || el.getAttribute("aria-labelledby") !== null;
          if (role === "" && !named && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "CODE")
            continue;
          out.push({ role: role || tag.toLowerCase(), name: accessibleName(el) || null });
        }
        return out;
      };
      // A demanded container that never rendered scopes nothing: refuse rather
      // than let the walk resolve a match outside the requested container.
      if (containerSpec && containers.length === 0 && nodes.length === 0)
        return { candidate_count: 0, found: foundReport() };

      const resolve = (matches: Element[]) => {
        const candidates = Array.from(new Set([...nodes, ...matches]));
        if (candidates.length === 0) return { candidate_count: 0, found: foundReport() };
        if (candidates.length > 1) return { candidate_count: candidates.length };
        const value = readValue(candidates[0]!);
        return { candidate_count: 1, ...(value.length > 0 ? { value } : {}) };
      };

      if ("selector" in spec) {
        const parentOf = (el: Element): Element | null => {
          const root = el.getRootNode();
          return el.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
        };
        const compound =
          /(?:[a-zA-Z_][\w-]*|\*|[.#][\w-]+|\[[\w-]+(?:[~|^$*]?=(?:"[^"\\]*"|'[^'\\]*'|[\w-]+))?\])+/y;
        const selector = spec.selector.trim();
        const parts: string[] = [];
        let offset = 0;
        while (offset < selector.length) {
          compound.lastIndex = offset;
          const part = compound.exec(selector);
          if (part === null) return resolve([]);
          parts.push(part[0]);
          offset = compound.lastIndex;
          if (offset === selector.length) break;
          const space = selector.slice(offset).match(/^\s+/);
          if (space === null) return resolve([]);
          offset += space[0].length;
        }
        if (parts.length === 0) return resolve([]);
        const anchors =
          parts.length > 1
            ? (containerSpec === null ? elements : containers).filter((el) => el.matches(parts[0]!))
            : [];
        const matchesSelector = (el: Element): boolean => {
          if (!el.matches(parts[parts.length - 1]!)) return false;
          if (parts.length === 1) return el.getRootNode() instanceof ShadowRoot;
          return anchors.some((anchor) => {
            if (el === anchor || !within(el, anchor)) return false;
            let current: Element | null = el;
            let remaining = parts.length - 2;
            let crossedShadow = false;
            while (current !== null && current !== anchor) {
              if (current.parentElement === null && current.getRootNode() instanceof ShadowRoot)
                crossedShadow = true;
              current = parentOf(current);
              if (current === anchor) return crossedShadow && remaining === 0;
              if (current !== null && remaining > 0 && current.matches(parts[remaining]!))
                remaining--;
            }
            return false;
          });
        };
        let visible: Element[] = [];
        try {
          document.querySelector(spec.selector);
          visible = elements.filter((el) => isVisible(el) && inScope(el) && matchesSelector(el));
        } catch {
          return resolve([]);
        }
        return resolve(visible);
      }

      const role = spec.role;
      let candidates = elements.filter(
        (el) => isVisible(el) && isAriaIncluded(el) && inScope(el) && ariaRole(el) === role,
      );
      if (spec.name !== undefined)
        candidates = candidates.filter((el) => accessibleName(el) === spec.name);
      return resolve(candidates);
    },
    { source, nodes: handles, scopeNodes: containerHandles },
  );
}
function captureSourceContainer(page: Page, source: CaptureSource) {
  return source.container === undefined
    ? undefined
    : page.getByRole(source.container.role, {
        ...(source.container.name !== undefined
          ? { name: source.container.name, exact: true }
          : {}),
      });
}

function captureSourceTargets(page: Page, source: CaptureSource) {
  const container = source.container === undefined ? page : captureSourceContainer(page, source)!;
  return "selector" in source
    ? container.locator(`css=${source.selector}`).filter({ visible: true })
    : container.getByRole(source.role, {
        ...(source.name !== undefined ? { name: source.name, exact: true } : {}),
      });
}

interface CaptureSourceResolution {
  candidate_count: number;
  value?: string;
  resolved_source?: { tag: string; role?: string; name?: string; selector?: string };
  resolved_from?: "post_action" | "pre_action_only";
  found?: CaptureFoundCandidate[];
}

async function readCaptureElement(handle: ElementHandle<Node>) {
  return await handle.evaluate((node) => {
    if (!node.isConnected || node.ownerDocument !== document)
      throw new Error("capture source changed");
    const value =
      node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
        ? node.value
        : node instanceof HTMLElement
          ? node.innerText
          : "";
    let resolved_source: CaptureSourceResolution["resolved_source"];
    if (node instanceof Element) {
      const tag = node.localName;
      const role =
        node.getAttribute("role") ||
        (node instanceof HTMLTextAreaElement ||
        (node instanceof HTMLInputElement && ["text", "email", "url", "tel"].includes(node.type))
          ? "textbox"
          : tag === "code"
            ? "code"
            : undefined);
      const root = node.getRootNode();
      const labelledBy = (node.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) =>
          root instanceof Document || root instanceof ShadowRoot
            ? (root.getElementById(id)?.textContent ?? "")
            : "",
        )
        .join(" ")
        .trim();
      const labels =
        node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
          ? Array.from(node.labels ?? [])
              .map((label) => label.textContent ?? "")
              .join(" ")
              .trim()
          : "";
      const name =
        labelledBy ||
        node.getAttribute("aria-label")?.trim() ||
        labels ||
        node.getAttribute("title")?.trim();
      resolved_source = {
        tag,
        ...(role ? { role } : {}),
        ...(name ? { name } : { selector: node.id ? `${tag}#${CSS.escape(node.id)}` : tag }),
      };
    }
    return { value: value.length <= 8192 ? value.trim() : "", resolved_source };
  });
}

/** Resolve a capture source once against the live document, disposing the
 * pinned handles. A new document must not satisfy the same locator while
 * capture is in flight. */
async function resolveCaptureSourceOnce(
  page: Page,
  source: CaptureSource,
): Promise<CaptureSourceResolution> {
  // A locator-engine failure is a zero-match, not a mystery: the explicit
  // shadow-piercing walk below still gets its chance to resolve the source.
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  try {
    // The reviewed resolver is walk-authoritative: engines can miss
    // shadow-hosted candidates or pin a stale light-DOM node. Union every
    // engine result with the explicit walk before requiring exactly one.
    const rejudged = await shadowPiercingCapture(page, source, handles, containerHandles);
    if (rejudged.candidate_count !== 1) return { ...rejudged };
    if (handles.length === 1) {
      const { value, resolved_source } = await readCaptureElement(handles[0]!);
      return {
        candidate_count: 1,
        ...(value.length > 0 ? { value } : {}),
        ...(resolved_source ? { resolved_source } : {}),
      };
    }
    return { ...rejudged };
  } finally {
    await Promise.all(
      [...handles, ...containerHandles].map((handle) => handle.dispose().catch(() => undefined)),
    );
  }
}

/** Live pre-action probe of a click capture's source. The single candidate's
 * handle stays alive so the post-action resolution can prove it is not merely
 * the pre-click element re-read; the caller must dispose it. */
export interface CaptureSourceProbe {
  candidate_count: number;
  value?: string;
  handle?: ElementHandle<Node>;
}

export async function probeCaptureSource(
  sessionId: string,
  source: CaptureSource,
): Promise<CaptureSourceProbe> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error("unknown provision session");
  const page = operationPageForSession(session);
  if (page === undefined) throw new Error("capture page unavailable");
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  const rejudged = await shadowPiercingCapture(page, source, handles, containerHandles);
  await Promise.all(containerHandles.map((handle) => handle.dispose().catch(() => undefined)));
  if (rejudged.candidate_count !== 1 || handles.length !== 1) {
    if (handles.length > 0)
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
    // A shadow-only source has no engine-pinned handle; post-action comparison
    // therefore falls back to the walk's value identity.
    return { ...rejudged };
  }
  const [handle] = handles;
  try {
    const { value } = await readCaptureElement(handle!);
    return { candidate_count: 1, handle: handle!, ...(value.length > 0 ? { value } : {}) };
  } catch (error) {
    await handle!.dispose().catch(() => undefined);
    throw error;
  }
}

async function sameDomElement(
  handle: ElementHandle<Node>,
  preHandle: ElementHandle<Node> | undefined,
): Promise<boolean> {
  if (preHandle === undefined) return false;
  try {
    return await handle.evaluate((node, other) => node === other, preHandle);
  } catch {
    return false; // stale pre-action handle — a different document's element
  }
}

// A click capture that re-reads the SAME element with the SAME value the
// pre-action probe saw proves only the pre-click document — the click's
// mutation has not rendered yet (the Groq key-dialog failure: the display-name
// textbox was the only pre-click textbox, and the capture vaulted its value as
// the key). Poll a bounded window for the mutation to render a changed
// resolution; if the source still resolves only as it did before the click,
// report pre_action_only so the caller treats storage as unresolved.
const CAPTURE_MUTATION_RENDER_BUDGET_MS = 2_000;
const CAPTURE_MUTATION_RENDER_POLL_MS = 250;

async function resolveChangedPostActionSource(
  page: Page,
  source: CaptureSource,
  pre: CaptureSourceProbe,
): Promise<CaptureSourceResolution | null> {
  const handles = await captureSourceTargets(page, source)
    .elementHandles()
    .catch(() => []);
  const containerHandles =
    (await captureSourceContainer(page, source)
      ?.elementHandles()
      .catch(() => [])) ?? [];
  try {
    const walked = await shadowPiercingCapture(page, source, handles, containerHandles);
    if (walked.candidate_count === 1) {
      const pinned = handles.length === 1 ? await readCaptureElement(handles[0]!) : undefined;
      const value = pinned?.value ?? walked.value ?? "";
      const unchanged =
        pre.candidate_count === 1 &&
        // A shadow-walked pre-probe has no live handle: value identity is the
        // only proof available, and an equal value still proves nothing new.
        (handles.length === 0 ||
          pre.handle === undefined ||
          (handles.length === 1 && (await sameDomElement(handles[0]!, pre.handle)))) &&
        (pre.value ?? "") === value;
      if (unchanged) return null;
      return {
        candidate_count: 1,
        ...(value.length > 0 ? { value } : {}),
        ...(pinned?.resolved_source ? { resolved_source: pinned.resolved_source } : {}),
      };
    }
    // Same non-unique (or still-empty) resolution as before the click — keep
    // waiting; the mutation may still be rendering.
    if (walked.candidate_count === pre.candidate_count) return null;
    return { ...walked };
  } finally {
    await Promise.all(
      [...handles, ...containerHandles].map((handle) => handle.dispose().catch(() => undefined)),
    );
  }
}

async function resolvePostActionCaptureSource(
  page: Page,
  source: CaptureSource,
  pre: CaptureSourceProbe,
): Promise<CaptureSourceResolution> {
  const deadline = Date.now() + CAPTURE_MUTATION_RENDER_BUDGET_MS;
  for (;;) {
    const changed = await resolveChangedPostActionSource(page, source, pre);
    if (changed !== null) return { ...changed, resolved_from: "post_action" };
    if (Date.now() >= deadline)
      return { candidate_count: pre.candidate_count, resolved_from: "pre_action_only" };
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_MUTATION_RENDER_POLL_MS));
  }
}

/** Explicit capture reads one named source without revealing other controls or
 * scanning unrelated page text. Normal extract/observe remain unchanged.
 * With `afterAction`, the source is judged against the POST-action document:
 * the click's own settle runs first, and a resolution indistinguishable from
 * the pre-action probe is reported as `pre_action_only` instead of stored. */
export async function captureCredentialSource(
  sessionId: string,
  source: CaptureSource,
  afterAction?: { pre?: CaptureSourceProbe | undefined },
): Promise<CaptureSourceResolution> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error("unknown provision session");
  const page = operationPageForSession(session);
  if (page === undefined) throw new Error("capture page unavailable");
  if (afterAction !== undefined) {
    // Same settle the click itself waits on — judge the source only after the
    // click's mutation has had its render window.
    await settleAfterStateChange(session.browser, page);
    return afterAction.pre === undefined
      ? { candidate_count: 0, resolved_from: "pre_action_only" }
      : await resolvePostActionCaptureSource(page, source, afterAction.pre);
  }
  return await resolveCaptureSourceOnce(page, source);
}

export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;
  const page = operationPageForSession(session);
  invalidateCompactV2Snapshot(session);

  // The masked-display trap: click reveal/show toggles before reading.
  await browser.revealMaskedCredentials(page);

  const labeled = await browser.extractLabeledCredentialCandidates(page);
  const inputs = await browser.extractAllInputValues(page);
  const nearCopy = await browser.extractCredentialsNearCopyButtons(page);
  const text = await browser.extractVisibleText(page);

  // Copy-only key surfaces (e.g. LangWatch's /settings/api-keys) never render
  // the value into the DOM — it goes to the clipboard on a "Copy" click. Read
  // it (clipboard-read is granted at context creation).
  const clip = await browser.readClipboard(page).catch(() => "");

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

  const relaxed = pickRelaxedNearCopyCredential(nearCopy);
  const acceptedNearCopyCredential =
    relaxed !== null &&
    !Object.entries(credentials).some(([key, value]) => key !== "api_key" && value === relaxed)
      ? relaxed
      : null;
  if (!("api_key" in credentials) && acceptedNearCopyCredential !== null) {
    credentials.api_key = acceptedNearCopyCredential;
  }

  // Multi-credential: a service may present several keys of the SAME family
  // (VouchFlow shows a vsk_ write AND a vsk_ read). Surface only tokens that
  // repeat a family already captured for THIS service — a cross-family token that
  // merely shares the page (a Resend dashboard's mcp-… widget beside the real re_
  // key) is page noise, not a second credential, and surfacing it pollutes the
  // credential + allow-lists an unrelated token to the service host (capture bug
  // 2026-07-09). A prefixless primary (deepinfra) yields no family, so no extras.
  const families = new Set(
    Object.values(credentials)
      .map((v) => (typeof v === "string" ? keyFamilyPrefix(v) : null))
      .filter((f): f is string => f !== null),
  );
  const have = new Set(Object.values(credentials));
  let n = 1;
  for (const tok of findCredentialTokens(haystack)) {
    if (have.has(tok)) continue;
    if (n >= 8) break; // cap extras so page noise can't flood the result
    const fam = keyFamilyPrefix(tok);
    if (fam === null || !families.has(fam)) continue;
    have.add(tok);
    n += 1;
    credentials[`api_key_${n}`] = tok;
  }
  const sanitized = sanitizeExtractedCredentials(
    credentials,
    page?.url() ?? browser.currentUrl(),
    haystack,
    acceptedNearCopyCredential,
  );
  const found = Object.keys(sanitized).length > 0;
  // A masked credential-shaped value that survived the reveal pass is an
  // UNREAD key, not success. Name it so a caller never believes every key is
  // vaulted when a sibling is still hidden; a masked value covered by a
  // readable capture under the same label is not remaining (see the helper).
  const maskedRemaining = maskedCredentialLabels(labeled, Object.keys(sanitized));
  audit(sessionId, "extract", { found, candidate_count: labeled.length });
  return {
    session_id: sessionId,
    url: page?.url() ?? browser.currentUrl(),
    credentials: sanitized,
    candidate_count: labeled.length,
    ...(maskedRemaining.length > 0 ? { masked_remaining: maskedRemaining } : {}),
  };
}
