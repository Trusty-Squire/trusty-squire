// Capture-side code, extracted verbatim from provision-session.ts
// (layer-contracts PR 11 — the capture module split). Owns the extract/capture
// thick-tool cluster: labeled-candidate sanitization and Vouchflow
// classification, the shadow-piercing capture walk, capture-source resolution
// (pre- and post-action), and the session-facing extractCredentials /
// captureCredentialSource / probeCaptureSource. No behaviour change.
// provision-session imports the session-facing entry points back and keeps
// re-exporting the tool layer's import surface; this module imports only from
// the rest of the tree, never from provision-session.

import type { ElementHandle, Locator, Page } from "playwright";
import type { CaptureSource, ElementCaptureSource } from "../credential-capture.js";
import type { Session } from "../session/model.js";
import { audit, sessionForCall } from "../session/lifecycle.js";
import { invalidateCompactV2Snapshot, operationPageForSession } from "../observe/observe.js";
import { waitForPageReady } from "../page-ready.js";
import { captureFrameSnapshot } from "../drive-snapshot.js";

// ── extraction (the `extract` thick tool) ──

export interface ExtractResult {
  session_id: string;
  url: string;
  // A value from a credential Copy control or a single labeled display.
  credentials: Record<string, string>;
  // Set when no key had a known source; nothing is stored.
  error?: string;
}

export const EXTRACT_NO_SOURCE_ERROR =
  "no_key_source: nothing stored. No credential Copy control or unambiguous labeled key display " +
  "yielded a value. Read the page " +
  "with operate_observe, then point capture at the key: operate_extract with " +
  "capture:{source:{selector}|{role,name?},store}, or operate_click on its Copy button " +
  "with capture:{source:{clipboard:true},store}.";

/** The credential fields a store keeps: truncated displays are dropped, and a
 * result holding only id fields is not a credential. Null when nothing is
 * storable. Decided by field name; the one value rule is that a web URL is not
 * a key, since a Copy beside an invite or docs link writes the link itself. */
export function storableCredentials(
  credentials: Record<string, string>,
): Record<string, string> | null {
  const kept = Object.fromEntries(
    Object.entries(credentials).filter(
      ([key, value]) => !key.endsWith("_truncated") && !isWebUrl(value),
    ),
  );
  return Object.keys(kept).some((key) => key !== "id" && !key.endsWith("_id")) ? kept : null;
}

function isWebUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

/** What a zero-match capture DID find, so the caller can pick a better source
 * on the next try: computed roles and accessible names only — never values. */
export interface CaptureFoundCandidate {
  role: string;
  name: string | null;
}

async function shadowPiercingCapture(
  page: Page,
  source: ElementCaptureSource,
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
function captureSourceContainer(page: Page, source: ElementCaptureSource) {
  return source.container === undefined
    ? undefined
    : page.getByRole(source.container.role, {
        ...(source.container.name !== undefined
          ? { name: source.container.name, exact: true }
          : {}),
      });
}

function captureSourceTargets(page: Page, source: ElementCaptureSource) {
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
  // A clipboard source that yielded nothing new. Never carries a value.
  clipboard_error?:
    | "capture_clipboard_unchanged"
    | "capture_clipboard_empty"
    | "capture_clipboard_unreadable";
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
  source: ElementCaptureSource,
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
  if ("clipboard" in source) {
    // The pre-click clipboard is the baseline: only a value the click newly
    // writes there is evidence of a copied credential.
    await ensureCaptureClipboardPermission(page);
    return { candidate_count: 1, value: (await session.browser.readClipboard(page)).trim() };
  }
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
  source: ElementCaptureSource,
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

/** Read the clipboard after a click until it holds a non-empty value that
 * differs from the pre-click baseline, within the mutation render budget. */
async function resolvePostActionClipboard(
  page: Page,
  browser: Session["browser"],
  pre: CaptureSourceProbe,
): Promise<CaptureSourceResolution> {
  const before = pre.value ?? "";
  const deadline = Date.now() + CAPTURE_MUTATION_RENDER_BUDGET_MS;
  for (;;) {
    const value = (await browser.readClipboard(page).catch(() => "")).trim();
    if (value.length > 0 && value !== before)
      return { candidate_count: 1, value, resolved_from: "post_action" };
    if (Date.now() >= deadline)
      return {
        candidate_count: 0,
        clipboard_error:
          value.length === 0 ? "capture_clipboard_empty" : "capture_clipboard_unchanged",
      };
    await new Promise((resolve) => setTimeout(resolve, CAPTURE_MUTATION_RENDER_POLL_MS));
  }
}

async function resolvePostActionCaptureSource(
  page: Page,
  source: ElementCaptureSource,
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
  if ("clipboard" in source) {
    // Without a pre-click baseline a clipboard value could be stale, so the
    // clipboard source is only judged after a click that was probed first.
    if (afterAction?.pre === undefined)
      return { candidate_count: 0, clipboard_error: "capture_clipboard_unreadable" };
    await waitForPageReady(page, { kind: "manual-action" });
    return await resolvePostActionClipboard(page, session.browser, afterAction.pre);
  }
  if (afterAction !== undefined) {
    // Same settle the click itself waits on — judge the source only after the
    // click's mutation has had its render window.
    await waitForPageReady(page, { kind: "manual-action" });
    return afterAction.pre === undefined
      ? { candidate_count: 0, resolved_from: "pre_action_only" }
      : await resolvePostActionCaptureSource(page, source, afterAction.pre);
  }
  return await resolveCaptureSourceOnce(page, source);
}

/** A CDP-attached headed Chrome may accept only part of the launch-time
 * context grant. Check the live origin before the first clipboard read: a
 * missing read grant can otherwise leave Chrome's permission prompt pending. */
async function ensureCaptureClipboardPermission(page: Page | undefined): Promise<void> {
  if (page === undefined) return;
  const permissions = await page
    .evaluate(async () => {
      try {
        const clipboardRead = (
          await navigator.permissions.query({ name: "clipboard-read" as PermissionName })
        ).state;
        const geolocation = (
          await navigator.permissions.query({ name: "geolocation" as PermissionName })
        ).state;
        return { clipboardRead, geolocation };
      } catch {
        return { clipboardRead: "prompt", geolocation: "prompt" };
      }
    })
    .catch(() => ({ clipboardRead: "prompt", geolocation: "prompt" }));
  if (permissions.clipboardRead === "granted") return;
  try {
    const origin = new URL(page.url()).origin;
    if (origin !== "null")
      await page
        .context()
        .grantPermissions(
          [
            "clipboard-read",
            "clipboard-write",
            ...(permissions.geolocation === "granted" ? ["geolocation"] : []),
          ],
          { origin },
        );
  } catch {
    // The normal DOM capture paths still have a chance when the page denies it.
  }
}

/** Copy-control cues: English plus the common localized labels (Kenari's
 * Indonesian "Salin"/"Tersalin"). A source string because `page.evaluate`
 * code cannot import; each in-page reader compiles it with the `iu` flags. */
const COPY_CUE_SOURCE = String.raw`cop(?:y|ied)|clipboard|(?<!\p{L})(?:salin|tersalin|disalin|copiar|copiado|copiada|copia|copiato|copier|copié|copiée|kopieren|kopiert|kopiëren|gekopieerd|kopiuj|skopiuj|kopiera|kopierad|kopier|kopioi|kopyala|sao chép)(?!\p{L})|копировать|скопировать|скопировано|コピー|复制|複製|복사|คัดลอก`;

type CopySourceWindow = Window & {
  /** A control whose click wrote `token` (or a cue-matched Copy control). */
  __tsCopySource?: { element: Element; token?: string | undefined };
  /** The next Copy candidate and its pre-click clipboard. */
  __tsCopyDispatch?: { element: Element; token?: string; before: string };
  __tsDriveRegistry?: { nodes: Map<string, Element> };
};

/** Resolve the displayed value beside the exact control, or find an inline
 * Copy source for extraction. Clipboard equality proves the association. */
async function inlineKeyCopy(
  page: Page,
  clickedRef?: string,
): Promise<{ button: Locator; token: string; cued: boolean } | null> {
  const picked = await page
    .evaluate(
      ({ copyCue, clickedRef }) => {
        const selector = 'button, [role="button"]';
        const controls = Array.from(document.querySelectorAll(selector));
        const clicked =
          clickedRef === undefined
            ? undefined
            : (window as CopySourceWindow).__tsDriveRegistry?.nodes.get(clickedRef);
        const cue = new RegExp(copyCue, "iu");
        const keyLabel = /\b(?:api[\s_-]*keys?|keys?|tokens?|secrets?|credentials?)\b/i;
        const keyPage =
          keyLabel.test(document.title) ||
          Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).some((heading) =>
            keyLabel.test(heading.textContent ?? ""),
          );
        const shown = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility === "visible" &&
            Number(style.opacity) > 0.01 &&
            !element.matches(":disabled")
          );
        };
        const valueOf = (element: Element): string =>
          (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : element.textContent ?? "").trim();
        // Plain text can share its node with a display label such as "API key:".
        const displayText = (text: string): string =>
          text.trim().replace(/^(?:(?:your|new)\s+)*(?:api[- ]?key|key|token|secret):\s+/i, "");
        const valueBeside = (control: Element, namedKey: boolean): string | undefined => {
          let anchor = control;
          for (let depth = 0; depth < 6; depth++) {
            const scope = anchor.parentElement;
            if (scope === null || scope === document.body || scope.matches("main")) break;
            const sibling = anchor.previousElementSibling;
            if (
              sibling?.matches(namedKey ? "span, p, output, pre" : "span, p, output") &&
              shown(sibling)
            ) {
              const value = displayText(valueOf(sibling));
              if (value.length > 0 && (!sibling.matches("pre") || !/\s/.test(value))) return value;
            }
            const values = Array.from(
              scope.querySelectorAll("code, input[readonly], textarea[readonly]"),
            )
              .filter((node) => shown(node) && node.closest(`pre, ${selector}`) === null)
              .map(valueOf)
              .filter(Boolean);
            if (values.length > 0) return new Set(values).size === 1 ? values[0] : undefined;
            const text = anchor.previousSibling;
            if (text?.nodeType === Node.TEXT_NODE && text.textContent?.trim()) {
              return displayText(text.textContent);
            }
            if (scope.querySelectorAll(selector).length > 1) break;
            anchor = scope;
          }
          return undefined;
        };
        const matches = controls.flatMap((control, index) => {
          if (
            (clickedRef !== undefined && control !== clicked) ||
            !shown(control) ||
            control.closest('dialog, [role="dialog"], [aria-modal="true"]') !== null
          ) {
            return [];
          }
          const label = [
            control.getAttribute("aria-label"),
            control.getAttribute("title"),
            control.textContent,
          ].join(" ");
          const cues = [control, control.querySelector("svg")].flatMap((node) =>
            ["id", "class", "data-testid", "data-icon"].map((attr) => node?.getAttribute(attr)),
          );
          const cued = cue.test([label, ...cues].join(" "));
          const namedKey = cued && keyLabel.test(label);
          if (
            (!namedKey && !keyPage) ||
            (clickedRef === undefined && !cued) ||
            /\b(?:setup|snippet|example|command)\b/i.test(label)
          ) {
            return [];
          }
          const token = valueBeside(control, namedKey);
          return token === undefined || /^https?:\/\/\S+$/i.test(token)
            ? []
            : [{ index, token, cued, namedKey }];
        });
        const named = matches.filter((match) => match.namedKey);
        const eligible = named.length === 0 ? matches : named;
        return eligible.every((match) => match.token === eligible[0]?.token)
          ? (eligible[0] ?? null)
          : null;
      },
      { copyCue: COPY_CUE_SOURCE, clickedRef },
    )
    .catch(() => null);
  if (picked === null) return null;
  return {
    button: page.locator('button, [role="button"]').nth(picked.index),
    token: picked.token,
    cued: picked.cued,
  };
}

/** The Copy control remembered on this document, while it is still shown. Its
 * label may have changed since ("Copy key" → "Copied"), so a retry must not
 * rediscover it by label. */
async function rememberedCopySource(page: Page): Promise<CopyControl | null> {
  const source: unknown = await page
    .evaluate(() => {
      const source = (window as CopySourceWindow).__tsCopySource;
      if (source === undefined || !source.element.isConnected) return null;
      const index = Array.from(document.querySelectorAll('button, [role="button"]')).indexOf(
        source.element,
      );
      return index < 0 ? null : { index, token: source.token };
    })
    .catch(() => null);
  if (typeof source !== "object" || source === null) return null;
  const { index, token } = source as { index: number; token?: string };
  return { button: page.locator('button, [role="button"]').nth(index), token };
}

type CopyControl = { button: Locator; token?: string | undefined };

/** The one decision on what a click on drive ref `ref` is to capture:
 * - `source`: the remembered Copy control, extraction's own Copy control, or a
 *   Copy-cued control beside a shown key (Salin, Copied). It is remembered, so
 *   the retry it arms clicks the same control, and it may pass the
 *   credential-mutation stop.
 * - `candidate`: an unlabelled control beside a shown key (an icon). Place
 *   alone cannot tell Copy from Revoke, so it only arms a retry; extraction
 *   then takes the clipboard only if it holds that key.
 * Skips the occlusion snapshot, which would re-register drive refs just
 * before the act. */
export async function copySourceClick(
  page: Page,
  ref: string,
): Promise<"source" | "candidate" | null> {
  const inline = await inlineKeyCopy(page, ref);
  const source =
    inline?.cued === true ? inline : inline === null ? await findCopySource(page, false) : null;
  const control = source ?? inline;
  if (control === null) return null;
  await ensureCaptureClipboardPermission(page);
  const marked = await control.button
    .evaluate(
      async (element, { ref, token, asSource }) => {
        const sourceWindow = window as CopySourceWindow;
        if (sourceWindow.__tsDriveRegistry?.nodes.get(ref) !== element) return false;
        const before = await navigator.clipboard.readText().catch(() => undefined);
        if (asSource) sourceWindow.__tsCopySource = { element, token };
        delete sourceWindow.__tsCopyDispatch;
        if (before !== undefined) {
          sourceWindow.__tsCopyDispatch = {
            element,
            before: before.trim(),
            ...(token === undefined ? {} : { token }),
          };
        }
        return true;
      },
      { ref, token: control.token, asSource: source !== null },
      { timeout: 1500 },
    )
    .catch(() => false);
  if (marked !== true) return null;
  return source !== null ? "source" : "candidate";
}

/** The page's Copy control for a revealed key: the remembered source, then one
 * in a modal or covering layer, then one beside a key shown inline. */
async function findCopySource(page: Page, withSnapshot = true): Promise<CopyControl | null> {
  const remembered = await rememberedCopySource(page);
  if (remembered !== null) return remembered;
  const modalSelector = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const target = await page.evaluate((copyCue) => {
    const cue = new RegExp(copyCue, "iu");
    const dialogs = Array.from(
      document.querySelectorAll(
        'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]',
      ),
    );
    for (let dialogIndex = dialogs.length - 1; dialogIndex >= 0; dialogIndex--) {
      const dialog = dialogs[dialogIndex]!;
      const context = `${dialog.getAttribute("aria-label") ?? ""} ${dialog.textContent ?? ""}`;
      if (!/\b(?:api\s*key|secret|token|credential|key)\b/i.test(context)) continue;
      const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'));
      for (let buttonIndex = 0; buttonIndex < buttons.length; buttonIndex++) {
        const button = buttons[buttonIndex]!;
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        if (
          rect.width <= 2 ||
          rect.height <= 2 ||
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) <= 0.01 ||
          (button instanceof HTMLButtonElement && button.disabled)
        )
          continue;
        const icon = button.querySelector("svg");
        const cues = [button, icon]
          .filter((element): element is Element => element !== null)
          .map((element) =>
            [
              element.textContent,
              element.getAttribute("aria-label"),
              element.getAttribute("title"),
              element.id,
              element.getAttribute("class"),
              element.getAttribute("data-testid"),
              element.getAttribute("data-icon"),
            ].join(" "),
          )
          .join(" ");
        if (cue.test(cues)) return { dialogIndex, buttonIndex };
      }
    }
    return null;
  }, COPY_CUE_SOURCE);
  let copyButton =
    target === null
      ? null
      : page
          .locator(modalSelector)
          .nth(target.dialogIndex)
          .locator('button, [role="button"]')
          .nth(target.buttonIndex);
  if (copyButton === null) {
    // A visually modal layer need not declare a dialog role. Start at the
    // viewport's topmost hit and walk its positioned ancestors: this limits
    // the search to the covering layer instead of any key settings behind it.
    // Snapshot occlusion alone can be empty when no background control is rowed.
    const buttonIndex = await page.evaluate((copyCue) => {
      const cue = new RegExp(copyCue, "iu");
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      let layer = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      while (layer !== null) {
        const style = getComputedStyle(layer);
        const rect = layer.getBoundingClientRect();
        if (
          (style.position === "fixed" || style.position === "absolute") &&
          rect.left <= innerWidth / 2 &&
          rect.right >= innerWidth / 2 &&
          rect.top <= innerHeight / 2 &&
          rect.bottom >= innerHeight / 2 &&
          /\b(?:api\s*key|secret|token|credential|key)\b/i.test(layer.textContent ?? "")
        ) {
          for (const button of buttons) {
            if (!layer.contains(button)) continue;
            const buttonRect = button.getBoundingClientRect();
            const buttonStyle = getComputedStyle(button);
            if (
              buttonRect.width <= 2 ||
              buttonRect.height <= 2 ||
              buttonStyle.display === "none" ||
              buttonStyle.visibility === "hidden" ||
              Number(buttonStyle.opacity) <= 0.01 ||
              (button instanceof HTMLButtonElement && button.disabled)
            )
              continue;
            const hit = document.elementFromPoint(
              buttonRect.left + buttonRect.width / 2,
              buttonRect.top + buttonRect.height / 2,
            );
            if (hit === null || !button.contains(hit)) continue;
            const icon = button.querySelector("svg");
            const cues = [button, icon]
              .filter((element): element is Element => element !== null)
              .map((element) =>
                [
                  element.textContent,
                  element.getAttribute("aria-label"),
                  element.getAttribute("title"),
                  element.id,
                  element.getAttribute("class"),
                  element.getAttribute("data-testid"),
                  element.getAttribute("data-icon"),
                ].join(" "),
              )
              .join(" ");
            if (cue.test(cues)) return buttons.indexOf(button);
          }
        }
        layer = layer.parentElement;
      }
      return null;
    }, COPY_CUE_SOURCE);
    if (buttonIndex !== null) copyButton = page.locator('button, [role="button"]').nth(buttonIndex);
  }
  if (copyButton === null && withSnapshot) {
    // The drive snapshot already hit-tests controls against covering layers.
    // Use that same evidence for a visually modal surface with no dialog role.
    const snapshot = await captureFrameSnapshot(page, [], 0);
    const covered =
      snapshot !== null &&
      !snapshot.timedOut &&
      snapshot.elements.some(
        (element) => element.occludedBy === "overlay" || element.occludedBy === "dialog",
      ) &&
      /\b(?:api\s*key|secret|token|credential|key)\b/i.test(snapshot.text);
    const candidates = (covered ? snapshot.elements : []).filter(
      (element) =>
        element.role === "button" &&
        element.occludedBy === undefined &&
        !element.offscreen &&
        element.selector !== undefined,
    );
    const selector =
      candidates.length === 0
        ? null
        : await page.evaluate(
            ({ refs, copyCue }) => {
              const cue = new RegExp(copyCue, "iu");
              const registry = (
                window as Window & {
                  __tsDriveRegistry?: { nodes: Map<string, Element> };
                }
              ).__tsDriveRegistry;
              for (const candidate of refs) {
                const button = registry?.nodes.get(candidate.ref);
                if (button === undefined || !button.isConnected) continue;
                const icon = button.querySelector("svg");
                const cues = [button, icon]
                  .filter((element): element is Element => element !== null)
                  .map((element) =>
                    [
                      element.textContent,
                      element.getAttribute("aria-label"),
                      element.getAttribute("title"),
                      element.id,
                      element.getAttribute("class"),
                      element.getAttribute("data-testid"),
                      element.getAttribute("data-icon"),
                    ].join(" "),
                  )
                  .join(" ");
                if (cue.test(cues)) return candidate.selector;
              }
              return null;
            },
            {
              refs: candidates.map(({ ref, selector }) => ({ ref, selector: selector! })),
              copyCue: COPY_CUE_SOURCE,
            },
          );
    if (selector !== null) copyButton = page.locator(selector);
  }
  // Some providers close the creation dialog and show the new key inline on
  // the list page (Kenari); its Copy control then sits beside the key itself.
  return copyButton === null ? await inlineKeyCopy(page) : { button: copyButton };
}

/** A created-key dialog may render its readable value outside DOM text (for
 * example in generated content) while keeping a stale mask in the DOM. Its
 * adjacent Copy control is then the page's authoritative value source. */
async function copyCredentialFromDialog(
  page: Page | undefined,
  browser: Session["browser"],
): Promise<string | null> {
  if (page === undefined) return null;
  // The model's latest click beside a shown key has already run, even if the
  // page then replaced that control: its clipboard is the evidence, and only
  // that key counts. A control proven this way is remembered for retries.
  const clipboard = (await browser.readClipboard(page).catch(() => "")).trim();
  const dispatched: unknown = await page
    .evaluate((clipboard) => {
      const sourceWindow = window as CopySourceWindow;
      const dispatch = sourceWindow.__tsCopyDispatch;
      delete sourceWindow.__tsCopyDispatch;
      if (
        dispatch === undefined ||
        clipboard.length === 0 ||
        clipboard === dispatch.before ||
        (dispatch.token !== undefined && dispatch.token !== clipboard)
      ) {
        return false;
      }
      if (dispatch.element.isConnected) sourceWindow.__tsCopySource = dispatch;
      return true;
    }, clipboard)
    .catch(() => false);
  if (dispatched === true) return clipboard;
  return await copyFromSource(page, browser);
}

async function copyFromSource(page: Page, browser: Session["browser"]): Promise<string | null> {
  const source = await findCopySource(page);
  if (source === null) return null;
  const copyButton = source.button;
  // Empty the clipboard first: a value present after the click was written by
  // this click, even when it equals what an earlier Copy click left there.
  const before = await browser.readClipboard(page).catch(() => "");
  const writeClipboard = async (text: string): Promise<boolean> =>
    await page
      .evaluate(async (value) => {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch {
          return false;
        }
      }, text)
      .catch(() => false);
  const cleared = await writeClipboard("");
  let copied = "";
  try {
    await copyButton.click({ timeout: 1500 });
    copied = (await browser.readClipboard(page).catch(() => "")).trim();
  } catch {
    // Fall through: nothing was copied.
  }
  if (
    copied.length === 0 ||
    (!cleared && copied === before.trim()) ||
    (source.token !== undefined && copied !== source.token)
  ) {
    // Leave the clipboard as the page found it when this control wrote nothing.
    if (cleared && before.length > 0) await writeClipboard(before);
    return null;
  }
  // This control wrote the clipboard: a retry after a failed store reuses it.
  await copyButton
    .evaluate((element, token) => {
      (window as CopySourceWindow).__tsCopySource = { element, token };
    }, source.token)
    .catch(() => undefined);
  return copied;
}

export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;
  const page = operationPageForSession(session);
  invalidateCompactV2Snapshot(session);

  // Prefer Copy when available. It may hold a full value behind a masked display.
  await ensureCaptureClipboardPermission(page);
  const copied = await copyCredentialFromDialog(page, browser);
  const key =
    copied === null || isWebUrl(copied) ? ((await readLabeledKeyDisplay(page)) ?? copied) : copied;
  audit(sessionId, "extract", { found: key !== null });
  return {
    session_id: sessionId,
    url: page?.url() ?? browser.currentUrl(),
    credentials: key === null ? {} : { api_key: key },
    ...(key === null ? { error: EXTRACT_NO_SOURCE_ERROR } : {}),
  };
}

/** A one-time key can appear as ordinary text with no Copy control. Require a
 * label attached to the display itself or directly before it. */
async function readLabeledKeyDisplay(page: Page | undefined): Promise<string | null> {
  if (page === undefined) return null;
  return await page
    .evaluate(() => {
      const keyLabel =
        /^(?:(?:your|new|generated|created)\s+)*api[- ]+(?:key|token|secret)(?:\s+(?:created|generated))?\s*:?$/i;
      const visible = (element: HTMLElement): boolean =>
        element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const values = new Set<string>();
      const displays = document.querySelectorAll<HTMLElement>("pre, code, div, p, span, output, dd");
      for (const display of Array.from(displays)) {
        if (!display.matches("pre, code") && display.childElementCount > 0) continue;
        const labelIds = display.getAttribute("aria-labelledby")?.trim().split(/\s+/) ?? [];
        const label = labelIds
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const previous = display.previousElementSibling;
        if (
          !keyLabel.test(label || display.getAttribute("aria-label")?.trim() || "") &&
          !(
            previous instanceof HTMLElement &&
            previous.matches(
              "h1, h2, h3, h4, h5, h6, [role=heading], label, dt, p, span, strong",
            ) &&
            visible(previous) &&
            keyLabel.test(previous.innerText.trim())
          )
        ) {
          continue;
        }
        if (!visible(display)) continue;
        const value = display.innerText.trim();
        if (
          value.length > 0 &&
          value.length <= 8192 &&
          !/\s|\*{2,}|[•●…]|\.{3}|^https?:\/\//i.test(value)
        ) {
          values.add(value);
        }
      }
      return values.size === 1 ? values.values().next().value! : null;
    })
    .catch(() => null);
}
