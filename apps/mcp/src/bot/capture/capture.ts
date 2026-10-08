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
import type { CaptureSource, ElementCaptureSource } from "../credential-capture.js";
import type { Session } from "../session/model.js";
import { audit, sessionForCall } from "../session/lifecycle.js";
import { invalidateCompactV2Snapshot, operationPageForSession } from "../observe/observe.js";
import { settleAfterStateChange } from "../act/act.js";
import { captureFrameSnapshot } from "../drive-snapshot.js";

// ── extraction (the `extract` thick tool) ──

export interface ExtractResult {
  session_id: string;
  url: string;
  // Only a value with a known source: what this extraction's own Copy click
  // in a credential dialog wrote to the clipboard. Page text is never scanned.
  credentials: Record<string, string>;
  // Set when no key had a known source; nothing is stored.
  error?: string;
}

export const EXTRACT_NO_SOURCE_ERROR =
  "no_key_source: nothing stored. operate_extract without capture stores only the value " +
  "a Copy button in a key dialog writes to the clipboard, and none did. Read the page " +
  "with operate_observe, then point capture at the key: operate_extract with " +
  "capture:{source:{selector}|{role,name?},store}, or operate_click on its Copy button " +
  "with capture:{source:{clipboard:true},store}.";

/** The credential fields a store keeps: truncated displays are dropped, and a
 * result holding only id fields is not a credential. Null when nothing is
 * storable. Decided by field name, never by the value's shape. */
export function storableCredentials(
  credentials: Record<string, string>,
): Record<string, string> | null {
  const kept = Object.fromEntries(
    Object.entries(credentials).filter(([key]) => !key.endsWith("_truncated")),
  );
  return Object.keys(kept).some((key) => key !== "id" && !key.endsWith("_id")) ? kept : null;
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
    await settleAfterStateChange(session.browser, page);
    return await resolvePostActionClipboard(page, session.browser, afterAction.pre);
  }
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

/** A created-key dialog may render its readable value outside DOM text (for
 * example in generated content) while keeping a stale mask in the DOM. Its
 * adjacent Copy control is then the page's authoritative value source. */
async function copyCredentialFromDialog(
  page: Page | undefined,
  browser: Session["browser"],
): Promise<string | null> {
  if (page === undefined) return null;
  const modalSelector = 'dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
  const target = await page.evaluate(() => {
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
        if (/copy|clipboard/i.test(cues)) return { dialogIndex, buttonIndex };
      }
    }
    return null;
  });
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
    const buttonIndex = await page.evaluate(() => {
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
            if (/copy|clipboard/i.test(cues)) return buttons.indexOf(button);
          }
        }
        layer = layer.parentElement;
      }
      return null;
    });
    if (buttonIndex !== null)
      copyButton = page.locator('button, [role="button"]').nth(buttonIndex);
  }
  if (copyButton === null) {
    // The drive snapshot already hit-tests controls against covering layers.
    // Use that same evidence for a visually modal surface with no dialog role.
    const snapshot = await captureFrameSnapshot(page, [], 0);
    if (
      snapshot === null ||
      snapshot.timedOut ||
      !snapshot.elements.some(
        (element) => element.occludedBy === "overlay" || element.occludedBy === "dialog",
      ) ||
      !/\b(?:api\s*key|secret|token|credential|key)\b/i.test(snapshot.text)
    )
      return null;
    const candidates = snapshot.elements.filter(
      (element) =>
        element.role === "button" &&
        element.occludedBy === undefined &&
        !element.offscreen &&
        element.selector !== undefined,
    );
    const selector = await page.evaluate(
      (refs) => {
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
          if (/copy|clipboard/i.test(cues)) return candidate.selector;
        }
        return null;
      },
      candidates.map(({ ref, selector }) => ({ ref, selector: selector! })),
    );
    if (selector === null) return null;
    copyButton = page.locator(selector);
  }
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
  if (copied.length === 0 || (!cleared && copied === before.trim())) {
    // Leave the clipboard as the page found it when this control wrote nothing.
    if (cleared && before.length > 0) await writeClipboard(before);
    return null;
  }
  return copied;
}

export async function extractCredentials(sessionId: string): Promise<ExtractResult> {
  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  const { browser } = session;
  const page = operationPageForSession(session);
  invalidateCompactV2Snapshot(session);

  // Storage is decided by source, never by shape: the Copy click itself proves
  // provenance, whatever the value looks like (Vast.ai's key is 64-char hex).
  await ensureCaptureClipboardPermission(page);
  const copied = await copyCredentialFromDialog(page, browser);
  audit(sessionId, "extract", { found: copied !== null });
  return {
    session_id: sessionId,
    url: page?.url() ?? browser.currentUrl(),
    credentials: copied === null ? {} : { api_key: copied },
    ...(copied === null ? { error: EXTRACT_NO_SOURCE_ERROR } : {}),
  };
}
