import type { Page } from "playwright";

export type PageNotReadyReason = "navigating" | "document_loading" | "no_rendered_content" | "hydrating" | "network_busy";
export type PageReadyResult = { ready: boolean; reason?: PageNotReadyReason; elapsedMs: number };
export type PageReadyRequest =
  | { kind: "drive-read" }
  | { kind: "drive-action"; combobox?: boolean; beforeFingerprint?: string; beforeEpoch?: string; watchChange?: boolean }
  | { kind: "manual-action" }
  | { kind: "observation" }
  | { kind: "model-wait"; signal?: AbortSignal }
  | { kind: "overlay"; phase?: "drive" | "widget_open" | "widget_arrow" }
  | { kind: "overlay-refresh"; before: readonly string[] }
  | { kind: "identical-resnap" }
  | { kind: "widget-reflow"; phase: "commit" | "close" }
  | { kind: "post-consent" } | { kind: "post-interstitial" } | { kind: "heading-paint" }
  | { kind: "document"; capMs: number } | { kind: "adopted-tab" }
  | { kind: "transient-alert"; capMs: number } | { kind: "address-change" }
  | { kind: "navigation-timeout" } | { kind: "form-start" }
  | { kind: "form-controls"; capMs: number } | { kind: "auth-widget"; capMs: number };

// Historical ceilings. A timeout never makes an unrendered page safe to read.
export const PAGE_READY_CAPS = {
  driveEmpty: 1_500, driveFrames: 50, driveOverlay: 400, widgetOpen: 600, widgetArrow: 400,
  widgetCommit: 300, widgetClose: 200, driveNavigation: 300, driveChange: 800,
  identicalResnap: 200, overlayRefresh: 2_000, manualInteractive: 2_000, manualProbe: 1_500,
  manualPoll: 500, observationNetwork: 1_500, observationQuiet: 500, observationQuietDeadline: 2_000,
  consentNetwork: 3_000, consentReflow: 800, interstitialHydration: 800, headingPaint: 800,
  adoptedBlank: 2_000, adoptedDocument: 15_000, addressChange: 500, navigationTimeout: 500,
  formDocument: 5_000, formNetwork: 1_500, formAuthWidget: 8_000, modelWait: 1_500,
} as const;
const INTERACTIVE = 'input,textarea,select,button,a[href],[role="button"],[role="menuitem"],[role="option"]';
const OVERLAY = '[role="option"],[role="listbox"] a,[role="listbox"] [role="option"],.suggestions a,' +
  '.suggestion-link,.suggestions-dropdown a,[aria-selected],[role="grid"] button,' +
  '[role="grid"] [role="gridcell"],[role="gridcell"],[role="dialog"] [role="gridcell"],' +
  '[role="dialog"] [role="grid"] button';
type Probe = { state: DocumentReadyState; rendered: boolean; painted: boolean };

// Serialized by Playwright into both the main document and visible child frames.
function documentProbe(selector: string): Probe {
  const body = document.body, text = (body?.innerText ?? "").trim();
  const visible = (node: Element) => {
    if (node.closest('[aria-hidden="true"],[inert]')) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.opacity !== "0";
  };
  const busy = body !== null && body.querySelector('[aria-busy="true"]') !== null;
  const loading = text.length < 120 && !/[\r\n]/.test(text) && /^(?:loading\b|please wait\b|just a moment\b)/i.test(text);
  return {
    state: document.readyState,
    rendered: Array.from(document.querySelectorAll(selector)).some(visible) || (!busy && !loading && text.length > 0),
    painted: !busy && !loading && Array.from(body?.children ?? []).some((node) =>
      !["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName) && visible(node)),
  };
}

async function bounded<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function probe(page: Page): Promise<Probe | null> {
  try {
    const deadline = Date.now() + PAGE_READY_CAPS.driveEmpty;
    const main = await bounded(page.evaluate(documentProbe, INTERACTIVE), PAGE_READY_CAPS.manualProbe, null);
    if (!main || main.rendered || typeof page.frames !== "function") return main;
    // An iframe-only checkout is rendered only when its visible child is painted.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached() || Date.now() >= deadline) continue;
      const left = () => Math.max(1, deadline - Date.now());
      const host = await bounded(frame.frameElement().catch(() => null), left(), null);
      if (!host) continue;
      const visible = await bounded(host.isVisible().catch(() => false), left(), false);
      const box = visible ? await bounded(host.boundingBox().catch(() => null), left(), null) : null;
      await host.dispose().catch(() => undefined);
      if (!box || box.width < 2 || box.height < 2 || Date.now() >= deadline) continue;
      const child = await bounded(frame.evaluate(documentProbe, INTERACTIVE).catch(() => null), left(), null);
      if (child?.state !== "loading" && (child?.rendered || child?.painted)) return { ...main, rendered: true };
    }
    return main;
  } catch { return null; }
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("operator_request_cancelled")); };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** One page-load policy. Each named plan entry has its former cap and evidence-specific reason. */
export async function waitForPageReady(page: Page, request: PageReadyRequest): Promise<PageReadyResult> {
  const started = Date.now(), C = PAGE_READY_CAPS;
  type Step = { name: string; cap: number; run: (cap: number) => Promise<unknown> };
  const plan: Step[] = [];
  const add = (name: string, cap: number, run: Step["run"]) => plan.push({ name, cap, run });
  const load = (state: "domcontentloaded" | "networkidle") => (cap: number) =>
    page.waitForLoadState(state, { timeout: cap }).then(() => true, () => false);
  const until = <T>(fn: (arg: T) => unknown, arg: T) => (cap: number) =>
    page.waitForFunction(fn as (arg: unknown) => unknown, arg, { timeout: cap }).then(() => true, () => false);
  const overlayVisible = (selector: string) => Array.from(document.querySelectorAll(selector)).some((node) => {
    if (node.closest('[aria-hidden="true"],[inert]')) return false;
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.opacity !== "0";
  });
  let networkBusy = false, domBusy = false, documentLoaded = true;

  switch (request.kind) {
    case "model-wait": // Model WAIT remains a deliberate 1.5 s re-observation.
      add("model_wait", C.modelWait, (cap) => pause(cap, request.signal)); break;
    case "adopted-tab": // Popup about:blank and parsed document: 2 s, then 15 s.
      add("adopted_blank", C.adoptedBlank, (cap) => page.waitForURL(
        (url) => !["", "about:blank", "about:srcdoc"].includes(url.toString()),
        { timeout: cap },
      ).catch(() => undefined));
      add("adopted_document", C.adoptedDocument, load("domcontentloaded")); break;
    case "document": // OAuth caller owns the remaining deadline; streaming pages need parsed DOM.
      add("document_loading", Math.max(1, request.capMs), async (cap) => { documentLoaded = await load("domcontentloaded")(cap); }); break;
    case "form-start": // Signup planning: parsed DOM plus bounded network polish.
      add("form_document", C.formDocument, load("domcontentloaded"));
      add("form_network", C.formNetwork, async (cap) => { networkBusy = !(await load("networkidle")(cap)); }); break;
    case "form-controls": // Nested SPA controls can arrive after the document.
      add("form_controls", request.capMs, (cap) => page.waitForSelector(
        'input, button, textarea, select, a[href], [role="button"], [role="menuitem"]',
        { state: "visible", timeout: cap },
      ).catch(() => undefined)); break;
    case "auth-widget": // Marketing links can precede the actual auth widget.
      add("auth_widget", request.capMs, until(() => {
        const visible = (node: Element) => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
        const any = (selector: string) => Array.from(document.querySelectorAll(selector)).some(visible);
        return any('input[type="email"],input[type="password"],input[name="email" i],input[name="password" i]') ||
          Array.from(document.querySelectorAll('button,a[href],[role="button"]')).some((node) =>
            visible(node) && /\b(sign\s?up|continue with|log ?in with|with google|with github|with sso|create account)\b/i.test((node.textContent ?? "").trim())) ||
          !any('[role="progressbar"],[aria-busy="true"],[class*="spin" i],[class*="loading" i],[class*="loader" i],.ant-spin,.MuiCircularProgress-root');
      }, undefined)); break;
    case "overlay": { // Combobox option mount: drive 400 ms, widget open 600 ms, arrow 400 ms.
      const cap = request.phase === "widget_open" ? C.widgetOpen : request.phase === "widget_arrow" ? C.widgetArrow : C.driveOverlay;
      add("overlay_options", cap, until(overlayVisible, OVERLAY)); break;
    }
    case "overlay-refresh": // Network-backed autocomplete replaces the option set within 2 s.
      add("overlay_refresh", C.overlayRefresh, until(({ selector, before }: { selector: string; before: readonly string[] }) => {
        const labels = Array.from(document.querySelectorAll(selector)).filter((node) => {
          if (node.closest('[aria-hidden="true"],[inert]')) return false;
          const style = getComputedStyle(node); return style.display !== "none" && style.visibility !== "hidden";
        }).map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim()).sort();
        const old = before.slice().sort();
        return labels.length > 0 && (labels.length !== old.length || labels.some((label, i) => label !== old[i]));
      }, { selector: OVERLAY, before: request.before })); break;
    case "identical-resnap": // Confirm an unchanged fingerprint after one delayed tick.
      add("identical_resnap", C.identicalResnap, pause); break;
    case "transient-alert": // Post-submit toast can arrive after the click.
      add("transient_alert", request.capMs, until(() => Array.from(document.querySelectorAll(
        "[role='alert'],[aria-live='assertive'],.ds-toast-container,.ds-notification-container,.Toastify__toast,.ant-message-notice,.ant-notification-notice,.sonner-toast",
      )).some((node) => (node.textContent ?? "").trim().length > 0), undefined)); break;
    case "address-change": // Shopify Places/geocoding starts after change or blur.
      add("address_change", C.addressChange, pause); break;
    case "navigation-timeout": // SPA route can commit just after the lifecycle timeout.
      add("navigation_timeout_route", C.navigationTimeout, pause); break;
    case "widget-reflow": // Option commit or portal close reflows the next control.
      add(`widget_${request.phase}`, request.phase === "commit" ? C.widgetCommit : C.widgetClose, pause); break;
    case "heading-paint": // Hidden SSR heading copy can precede first painted heading.
      add("heading_paint", C.headingPaint, until(() => {
        const headings = Array.from(document.querySelectorAll("h1,h2"));
        return !headings.some((node) => (node.textContent ?? "").trim()) || headings.some((node) => {
          const box = node.getBoundingClientRect(); return box.width >= 2 && box.height >= 2;
        });
      }, undefined)); break;
    case "post-consent": // Dismissal can reveal chooser after network activity and reflow.
      add("consent_network", C.consentNetwork, load("networkidle"));
      add("consent_reflow", C.consentReflow, pause); break;
    case "post-interstitial": // Product page hydrates after challenge clearance.
      add("interstitial_hydration", C.interstitialHydration, pause); break;
    case "drive-action": // Two frames, optional overlay, then 300/800 ms page-change watcher.
      add("drive_frames", C.driveFrames, (cap) => Promise.race([
        page.evaluate((limit) => Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          new Promise<void>((r) => setTimeout(r, limit)),
        ]), cap).catch(() => undefined), pause(cap),
      ]));
      if (request.combobox) add("overlay_options", C.driveOverlay, until(overlayVisible, OVERLAY));
      if (request.beforeFingerprint) add("drive_change", C.driveChange, async () => {
        const origin = await bounded(page.evaluate(() => String(performance.timeOrigin)).catch(() => ""), C.driveFrames, "");
        const previous = request.beforeEpoch?.split("|")[0] ?? "";
        const navigation = !!previous && !!origin && previous !== origin;
        if (!navigation && !request.watchChange) return;
        await until((prior: string) => {
          const text = document.body?.innerText.slice(0, 6000) ?? "";
          const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            "input,select,textarea",
          )).map((el) => `${el.tagName}:${el.type}:${el.value}`).join("\n");
          const current = [text, controls].join("\n").trim(); return current.length > 0 && current !== prior;
        }, request.beforeFingerprint!)(navigation ? C.driveNavigation : C.driveChange);
      }); break;
    case "manual-action": { // Poll a visible control for the former 2 s cap.
      add("interactive_dom", C.manualInteractive, async (limit) => {
        const deadline = Date.now() + limit;
        while (Date.now() < deadline) {
          const found = await bounded(page.evaluate(({ selector, minimum }) =>
            Array.from(document.querySelectorAll(selector)).filter((node) => {
              const box = node.getBoundingClientRect(); return box.width >= 2 && box.height >= 2;
            }).length >= minimum, { selector: INTERACTIVE, minimum: 1 }).catch(() => false), C.manualProbe, false);
          if (found) break;
          await pause(Math.min(C.manualPoll, Math.max(0, deadline - Date.now())));
        }
      }); break;
    }
    case "observation": // 1.5 s network cap, then 500 ms DOM-quiet floor with 2 s deadline.
      add("observation_network", C.observationNetwork, async (cap) => { networkBusy = !(await load("networkidle")(cap)); });
      add("observation_dom_quiet", C.observationQuietDeadline, async (cap) => {
        domBusy = !(await page.evaluate(({ quietMs, capMs }) => new Promise<boolean>((resolve) => {
          let quiet: ReturnType<typeof setTimeout>;
          const finish = (settled: boolean) => { clearTimeout(quiet); clearTimeout(deadline); observer.disconnect(); resolve(settled); };
          const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(() => finish(true), quietMs); });
          const deadline = setTimeout(() => finish(false), capMs);
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          quiet = setTimeout(() => finish(true), quietMs);
        }), { quietMs: C.observationQuiet, capMs: cap }).catch(() => false));
      }); break;
  }
  for (const step of plan) await step.run(step.cap);
  const result = (reason?: PageNotReadyReason): PageReadyResult => ({ ready: reason === undefined, ...(reason ? { reason } : {}), elapsedMs: Date.now() - started });
  const eventOnly = ["overlay", "overlay-refresh", "identical-resnap", "transient-alert",
    "address-change", "navigation-timeout", "widget-reflow", "heading-paint"];
  if (eventOnly.includes(request.kind) || (request.kind === "drive-action" && !request.beforeFingerprint))
    return result();
  let current = await probe(page);
  if (!current && !page.isClosed()) { // New document after old JS context was destroyed: 1.5 s.
    await load("domcontentloaded")(C.driveEmpty); current = await probe(page);
  }
  if (!current) return result("navigating");
  if (request.kind === "document") return result(documentLoaded && current.state !== "loading" ? undefined : "document_loading");
  if (current.state === "loading") { await load("domcontentloaded")(C.driveEmpty); current = await probe(page); }
  if (!current) return result("navigating");
  if (current.state === "loading") return result("document_loading");
  if (!current.rendered && request.kind === "drive-read") { // Former 1.5 s empty-snapshot window.
    await until((selector: string) => {
      const text = (document.body?.innerText ?? "").trim();
      const loading = text.length < 120 && !/[\r\n]/.test(text) && /^(?:loading\b|please wait\b|just a moment\b)/i.test(text);
      return (!document.body?.querySelector('[aria-busy="true"]') && !loading && text.length > 0) || Array.from(document.querySelectorAll(selector)).some((node) => {
        if (node.closest('[aria-hidden="true"],[inert]')) return false;
        const box = node.getBoundingClientRect(), style = getComputedStyle(node);
        return box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.opacity !== "0";
      });
    }, INTERACTIVE)(C.driveEmpty);
    current = await probe(page);
  }
  if (!current) return result("navigating");
  if (!current.rendered) return result(domBusy ? "hydrating" : networkBusy ? "network_busy" : "no_rendered_content");
  return result();
}
