import type { Page } from "playwright";

export type PageNotReadyReason =
  | "navigating"
  | "document_loading"
  | "no_rendered_content"
  | "hydrating"
  | "network_busy";

export type PageReadyStep = {
  name: string;
  capMs: number;
  elapsedMs: number;
};

export type PageReadyResult = {
  ready: boolean;
  reason?: PageNotReadyReason;
  elapsedMs: number;
  steps: PageReadyStep[];
};

export type PageReadyRequest =
  | { kind: "drive-read" }
  | {
      kind: "drive-action";
      combobox?: boolean;
      beforeFingerprint?: string;
      beforeEpoch?: string;
      watchChange?: boolean;
    }
  | { kind: "manual-action" }
  | { kind: "interactive"; minElements: number; capMs: number }
  | { kind: "observation" }
  | { kind: "model-wait"; signal?: AbortSignal }
  | { kind: "overlay"; phase?: "drive" | "widget_open" | "widget_arrow" }
  | { kind: "overlay-refresh"; before: readonly string[] }
  | { kind: "identical-resnap" }
  | { kind: "widget-reflow"; phase: "commit" | "close" }
  | { kind: "post-consent" }
  | { kind: "post-interstitial" }
  | { kind: "heading-paint" }
  | { kind: "document"; capMs: number }
  | { kind: "adopted-tab" }
  | { kind: "transient-alert"; capMs: number }
  | { kind: "address-change" }
  | { kind: "navigation-timeout" }
  | { kind: "form-start" }
  | { kind: "form-controls"; capMs: number }
  | { kind: "auth-widget"; capMs: number };

// These are the pre-consolidation ceilings. A cap is a safety bound, not a
// claim that a timeout makes an unrendered page safe to read.
export const PAGE_READY_CAPS = {
  driveEmpty: 1_500,
  driveFrames: 50,
  driveOverlay: 400,
  widgetOpen: 600,
  widgetArrow: 400,
  widgetCommit: 300,
  widgetClose: 200,
  driveNavigation: 300,
  driveChange: 800,
  identicalResnap: 200,
  overlayRefresh: 2_000,
  manualInteractive: 2_000,
  manualProbe: 1_500,
  manualPoll: 500,
  observationNetwork: 1_500,
  observationQuiet: 500,
  observationQuietDeadline: 2_000,
  consentNetwork: 3_000,
  consentReflow: 800,
  interstitialHydration: 800,
  headingPaint: 800,
  adoptedBlank: 2_000,
  adoptedDocument: 15_000,
  addressChange: 500,
  navigationTimeout: 500,
  formDocument: 5_000,
  formNetwork: 1_500,
  formAuthWidget: 8_000,
  modelWait: 1_500,
} as const;

const INTERACTIVE_SELECTOR =
  'input,textarea,select,button,a[href],[role="button"],[role="menuitem"],[role="option"]';
const OVERLAY_SELECTOR =
  '[role="option"],[role="listbox"] a,[role="listbox"] [role="option"],.suggestions a,.suggestion-link,.suggestions-dropdown a,[aria-selected],[role="grid"] button,[role="grid"] [role="gridcell"],[role="gridcell"],[role="dialog"] [role="gridcell"],[role="dialog"] [role="grid"] button';

type Probe = { state: DocumentReadyState; rendered: boolean; painted?: boolean };

function readDocumentProbe(selector: string): Probe {
  const body = document.body;
  const text = (body?.innerText ?? "").trim();
  const visibleControl = Array.from(document.querySelectorAll(selector)).some((node) => {
    if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return (
      box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.opacity !== "0"
    );
  });
  const busy = body !== null && body.querySelector('[aria-busy="true"]') !== null;
  const loadingLabel =
    text.length < 120 &&
    !/[\r\n]/.test(text) &&
    /^(?:loading\b|please wait\b|just a moment\b)/i.test(text);
  const painted =
    !busy &&
    !loadingLabel &&
    Array.from(body?.children ?? []).some((node) => {
      if (["SCRIPT", "STYLE", "LINK", "META"].includes(node.tagName)) return false;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return (
        box.width >= 2 && box.height >= 2 && style.visibility !== "hidden" && style.opacity !== "0"
      );
    });
  return {
    state: document.readyState,
    rendered: visibleControl || (!busy && !loadingLabel && text.length > 0),
    painted,
  };
}

async function probe(page: Page): Promise<Probe | null> {
  try {
    const deadline = Date.now() + PAGE_READY_CAPS.driveEmpty;
    const main = await bounded(
      page.evaluate(readDocumentProbe, INTERACTIVE_SELECTOR),
      PAGE_READY_CAPS.manualProbe,
      null,
    );
    if (main === null || main.rendered || typeof page.frames !== "function") return main;
    // A page can consist entirely of a visible, cross-origin iframe. Inspect
    // its own document before declaring the parent blank; hidden tracking
    // frames cannot make an unfinished page ready.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame() || frame.isDetached()) continue;
      let remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const handle = await bounded(
        frame.frameElement().catch(() => null),
        remaining,
        null,
      );
      if (handle === null) continue;
      remaining = deadline - Date.now();
      if (remaining <= 0) {
        await handle.dispose().catch(() => undefined);
        break;
      }
      const visible = await bounded(
        handle.isVisible().catch(() => false),
        remaining,
        false,
      );
      remaining = deadline - Date.now();
      const bounds = visible
        ? await bounded(
            handle.boundingBox().catch(() => null),
            Math.max(1, remaining),
            null,
          )
        : null;
      await handle.dispose().catch(() => undefined);
      if (!visible || bounds === null || bounds.width < 2 || bounds.height < 2) continue;
      remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const child = await bounded(
        frame.evaluate(readDocumentProbe, INTERACTIVE_SELECTOR).catch(() => null),
        remaining,
        null,
      );
      if (child?.state !== "loading" && (child?.rendered || child?.painted)) {
        return { ...main, rendered: true };
      }
    }
    return main;
  } catch {
    return null;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("operator_request_cancelled"));
    };
    const timer = setTimeout(done, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function bounded<T>(work: Promise<T>, capMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), capMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The only load/settle policy used by drive, manual act and observation.
 * Every extension is an evidence-specific step with the former cap retained.
 */
export async function waitForPageReady(
  page: Page,
  request: PageReadyRequest,
): Promise<PageReadyResult> {
  const started = Date.now();
  const steps: PageReadyStep[] = [];
  const step = async (name: string, capMs: number, run: () => Promise<void>): Promise<void> => {
    const begin = Date.now();
    await run();
    steps.push({ name, capMs, elapsedMs: Date.now() - begin });
  };
  const readProbe = async (): Promise<Probe | null> => {
    // A bounded render probe checks the main document and any visible child
    // frame. It is recorded even when the page is already ready.
    const begin = Date.now();
    const current = await probe(page);
    steps.push({
      name: "render_probe",
      capMs: PAGE_READY_CAPS.driveEmpty,
      elapsedMs: Date.now() - begin,
    });
    return current;
  };
  const result = (reason?: PageNotReadyReason): PageReadyResult => ({
    ready: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    elapsedMs: Date.now() - started,
    steps,
  });
  let networkBusy = false;
  let domBusy = false;
  let documentLoaded = true;

  if (request.kind === "model-wait") {
    // The model's WAIT remains a deliberate 1.5 s re-observation choice.
    await step("model_wait", PAGE_READY_CAPS.modelWait, () =>
      sleep(PAGE_READY_CAPS.modelWait, request.signal),
    );
  }

  if (request.kind === "adopted-tab") {
    // A popup starts at about:blank. Wait for its own navigation, then for
    // its parsed document; these are the previous 40×50 ms and 15 s caps.
    await step("adopted_blank", PAGE_READY_CAPS.adoptedBlank, async () => {
      await bounded(
        page
          .waitForURL((url) => !["", "about:blank", "about:srcdoc"].includes(url.toString()), {
            timeout: PAGE_READY_CAPS.adoptedBlank,
          })
          .catch(() => undefined),
        PAGE_READY_CAPS.adoptedBlank,
        undefined,
      );
    });
    await step("adopted_document", PAGE_READY_CAPS.adoptedDocument, async () => {
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: PAGE_READY_CAPS.adoptedDocument,
        })
        .catch(() => undefined);
    });
  }

  if (request.kind === "document") {
    // OAuth and navigation owners pass their existing remaining deadline.
    const cap = Math.max(1, request.capMs);
    await step("document_loading", cap, async () => {
      documentLoaded = await page
        .waitForLoadState("domcontentloaded", { timeout: cap })
        .then(() => true)
        .catch(() => false);
    });
  }

  if (request.kind === "form-start") {
    // Legacy signup planning needs parsed DOM plus the same short network
    // polish; anti-bot clearance remains its own challenge event outside this.
    await step("form_document", PAGE_READY_CAPS.formDocument, async () => {
      await page
        .waitForLoadState("domcontentloaded", { timeout: PAGE_READY_CAPS.formDocument })
        .catch(() => undefined);
    });
    await step("form_network", PAGE_READY_CAPS.formNetwork, async () => {
      networkBusy = !(await page
        .waitForLoadState("networkidle", { timeout: PAGE_READY_CAPS.formNetwork })
        .then(() => true)
        .catch(() => false));
    });
  }

  if (request.kind === "form-controls") {
    // Nested SPA pages can render their first addressable control late.
    await step("form_controls", request.capMs, async () => {
      await page
        .waitForSelector(
          'input, button, textarea, select, a[href], [role="button"], [role="menuitem"]',
          { state: "visible", timeout: request.capMs },
        )
        .catch(() => undefined);
    });
  }

  if (request.kind === "auth-widget") {
    // Marketing links may render before an auth widget while a spinner shows.
    await step("auth_widget", request.capMs, async () => {
      await page
        .waitForFunction(
          () => {
            const visible = (node: Element): boolean => {
              const box = node.getBoundingClientRect();
              return box.width > 0 && box.height > 0;
            };
            const anyVisible = (selector: string): boolean =>
              Array.from(document.querySelectorAll(selector)).some(visible);
            const authInput = anyVisible(
              'input[type="email"],input[type="password"],input[name="email" i],input[name="password" i]',
            );
            const authButton = Array.from(
              document.querySelectorAll('button,a[href],[role="button"]'),
            ).some(
              (node) =>
                visible(node) &&
                /\b(sign\s?up|continue with|log ?in with|with google|with github|with sso|create account)\b/i.test(
                  (node.textContent ?? "").trim(),
                ),
            );
            const spinner = anyVisible(
              '[role="progressbar"],[aria-busy="true"],[class*="spin" i],[class*="loading" i],[class*="loader" i],.ant-spin,.MuiCircularProgress-root',
            );
            return authInput || authButton || !spinner;
          },
          undefined,
          { timeout: request.capMs },
        )
        .catch(() => undefined);
    });
  }

  const waitOverlay = async (cap: number): Promise<void> => {
    // A combobox option can mount after the trigger or ArrowDown dispatch.
    await step("overlay_options", cap, async () => {
      await page
        .waitForFunction(
          (selector: string) =>
            Array.from(document.querySelectorAll(selector)).some((node) => {
              if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
              const box = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return (
                box.width >= 2 &&
                box.height >= 2 &&
                style.visibility !== "hidden" &&
                style.opacity !== "0"
              );
            }),
          OVERLAY_SELECTOR,
          { timeout: cap },
        )
        .catch(() => undefined);
    });
  };
  if (request.kind === "overlay") {
    const cap =
      request.phase === "widget_open"
        ? PAGE_READY_CAPS.widgetOpen
        : request.phase === "widget_arrow"
          ? PAGE_READY_CAPS.widgetArrow
          : PAGE_READY_CAPS.driveOverlay;
    await waitOverlay(cap);
    return result();
  }

  if (request.kind === "overlay-refresh") {
    // Autocomplete can keep its old options until the network-backed set
    // replaces them. The prior drive watcher allowed the same 2 s window.
    await step("overlay_refresh", PAGE_READY_CAPS.overlayRefresh, async () => {
      await page
        .waitForFunction(
          ({ selector, before }: { selector: string; before: readonly string[] }) => {
            const labels = Array.from(document.querySelectorAll(selector))
              .filter((node) => {
                if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
                const style = getComputedStyle(node);
                return style.display !== "none" && style.visibility !== "hidden";
              })
              .map((node) => (node.textContent ?? "").replace(/\s+/g, " ").trim());
            if (labels.length === 0) return false;
            const previous = before.slice().sort();
            return (
              labels.length !== previous.length ||
              labels
                .slice()
                .sort()
                .some((label, index) => label !== previous[index])
            );
          },
          { selector: OVERLAY_SELECTOR, before: request.before },
          { timeout: PAGE_READY_CAPS.overlayRefresh, polling: "raf" },
        )
        .catch(() => undefined);
    });
    return result();
  }

  if (request.kind === "identical-resnap") {
    // A just-dispatched action can render a changed state one tick after the
    // first fingerprint read. Keep its former 200 ms confirmation window.
    await step("identical_resnap", PAGE_READY_CAPS.identicalResnap, () =>
      sleep(PAGE_READY_CAPS.identicalResnap),
    );
    return result();
  }

  if (request.kind === "transient-alert") {
    // A post-submit toast can arrive after the click and disappear quickly.
    await step("transient_alert", request.capMs, async () => {
      await page
        .waitForFunction(
          () =>
            Array.from(
              document.querySelectorAll(
                "[role='alert'],[aria-live='assertive'],.ds-toast-container,.ds-notification-container,.Toastify__toast,.ant-message-notice,.ant-notification-notice,.sonner-toast",
              ),
            ).some((node) => (node.textContent ?? "").trim().length > 0),
          undefined,
          { timeout: request.capMs },
        )
        .catch(() => undefined);
    });
    return result();
  }

  if (request.kind === "address-change") {
    // Shopify's change/blur handler starts bounded Places/geocoding work.
    await step("address_change", PAGE_READY_CAPS.addressChange, () =>
      sleep(PAGE_READY_CAPS.addressChange),
    );
    return result();
  }

  if (request.kind === "navigation-timeout") {
    // A client-routed SPA can commit the URL just after Playwright's lifecycle timeout.
    await step("navigation_timeout_route", PAGE_READY_CAPS.navigationTimeout, () =>
      sleep(PAGE_READY_CAPS.navigationTimeout),
    );
    return result();
  }

  if (request.kind === "widget-reflow") {
    const cap =
      request.phase === "commit" ? PAGE_READY_CAPS.widgetCommit : PAGE_READY_CAPS.widgetClose;
    // The selected row or closing portal may reflow the next control.
    await step(`widget_${request.phase}`, cap, () => sleep(cap));
    return result();
  }

  if (request.kind === "heading-paint") {
    // Hidden SSR heading copy can precede the first painted heading.
    await step("heading_paint", PAGE_READY_CAPS.headingPaint, async () => {
      await page
        .waitForFunction(
          () => {
            const headings = Array.from(document.querySelectorAll("h1,h2"));
            const withCopy = headings.some((node) => (node.textContent ?? "").trim().length > 0);
            return (
              !withCopy ||
              headings.some((node) => {
                const box = node.getBoundingClientRect();
                return box.width >= 2 && box.height >= 2;
              })
            );
          },
          undefined,
          { timeout: PAGE_READY_CAPS.headingPaint },
        )
        .catch(() => undefined);
    });
    return result();
  }

  if (request.kind === "post-consent") {
    // Consent dismissal can reveal a chooser after network activity and
    // reflow. Preserve both former ceilings until paired data supports a change.
    await step("consent_network", PAGE_READY_CAPS.consentNetwork, async () => {
      await page
        .waitForLoadState("networkidle", { timeout: PAGE_READY_CAPS.consentNetwork })
        .catch(() => undefined);
    });
    await step("consent_reflow", PAGE_READY_CAPS.consentReflow, () =>
      sleep(PAGE_READY_CAPS.consentReflow),
    );
  }

  if (request.kind === "post-interstitial") {
    // An anti-bot challenge can clear before the product page hydrates.
    await step("interstitial_hydration", PAGE_READY_CAPS.interstitialHydration, () =>
      sleep(PAGE_READY_CAPS.interstitialHydration),
    );
  }

  if (request.kind === "drive-action") {
    // Two animation frames let the action's synchronous rendering land. The
    // outer timer also resolves when navigation destroys the old JS context.
    await step("drive_frames", PAGE_READY_CAPS.driveFrames, async () => {
      await Promise.race([
        page
          .evaluate(
            (cap: number) =>
              Promise.race([
                new Promise<void>((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                ),
                new Promise<void>((resolve) => setTimeout(resolve, cap)),
              ]),
            PAGE_READY_CAPS.driveFrames,
          )
          .catch(() => undefined),
        sleep(PAGE_READY_CAPS.driveFrames),
      ]);
    });
    if (request.combobox) await waitOverlay(PAGE_READY_CAPS.driveOverlay);
    if (!request.beforeFingerprint) return result();
    const before = request.beforeFingerprint;
    const afterOrigin = await bounded(
      page.evaluate(() => String(performance.timeOrigin)).catch(() => ""),
      PAGE_READY_CAPS.driveFrames,
      "",
    );
    const previousOrigin = request.beforeEpoch?.split("|")[0] ?? "";
    const navigation =
      previousOrigin.length > 0 && afterOrigin.length > 0 && previousOrigin !== afterOrigin;
    if (before && (navigation || request.watchChange)) {
      const cap = navigation ? PAGE_READY_CAPS.driveNavigation : PAGE_READY_CAPS.driveChange;
      // Navigation and same-document swaps have different historical caps.
      // A changed body/field value is the signal, not a fixed dwell.
      await step(navigation ? "drive_navigation" : "drive_change", cap, async () => {
        await page
          .waitForFunction(
            (prior: string) => {
              const text = document.body?.innerText.slice(0, 6000) ?? "";
              const controls = Array.from(
                document.querySelectorAll<
                  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >("input,select,textarea"),
              )
                .map((element) => `${element.tagName}:${element.type}:${element.value}`)
                .join("\n");
              const current = [text, controls].join("\n").trim();
              return current.length > 0 && current !== prior;
            },
            before,
            { timeout: cap },
          )
          .catch(() => undefined);
      });
    }
  }

  if (request.kind === "manual-action" || request.kind === "interactive") {
    const cap =
      request.kind === "manual-action" ? PAGE_READY_CAPS.manualInteractive : request.capMs;
    const min = request.kind === "manual-action" ? 1 : request.minElements;
    // Manual acts previously polled one visible control for 2 s; legacy
    // callers may request a larger inventory with their existing deadline.
    await step("interactive_dom", cap, async () => {
      const deadline = Date.now() + cap;
      while (Date.now() < deadline) {
        const found = await bounded(
          page
            .evaluate(
              ({ selector, minimum }: { selector: string; minimum: number }) =>
                Array.from(document.querySelectorAll(selector)).filter((node) => {
                  const box = node.getBoundingClientRect();
                  return box.width >= 2 && box.height >= 2;
                }).length >= minimum,
              { selector: INTERACTIVE_SELECTOR, minimum: min },
            )
            .catch(() => false),
          PAGE_READY_CAPS.manualProbe,
          false,
        );
        if (found) break;
        await sleep(Math.min(PAGE_READY_CAPS.manualPoll, Math.max(0, deadline - Date.now())));
      }
    });
  }

  if (request.kind === "observation") {
    // Network quiet is a bounded polish signal. Analytics may never settle;
    // DOM content and quiet, rather than networkidle alone, decide readiness.
    await step("observation_network", PAGE_READY_CAPS.observationNetwork, async () => {
      networkBusy = !(await page
        .waitForLoadState("networkidle", {
          timeout: PAGE_READY_CAPS.observationNetwork,
        })
        .then(() => true)
        .catch(() => false));
    });
    await step("observation_dom_quiet", PAGE_READY_CAPS.observationQuietDeadline, async () => {
      domBusy = !(await page
        .evaluate(
          ({ quietMs, capMs }: { quietMs: number; capMs: number }) =>
            new Promise<boolean>((resolve) => {
              let quiet: ReturnType<typeof setTimeout>;
              const observer = new MutationObserver(() => {
                clearTimeout(quiet);
                quiet = setTimeout(() => finish(true), quietMs);
              });
              const finish = (settled: boolean) => {
                clearTimeout(quiet);
                clearTimeout(deadline);
                observer.disconnect();
                resolve(settled);
              };
              const deadline = setTimeout(() => finish(false), capMs);
              observer.observe(document, {
                subtree: true,
                childList: true,
                attributes: true,
                characterData: true,
              });
              quiet = setTimeout(() => finish(true), quietMs);
            }),
          {
            quietMs: PAGE_READY_CAPS.observationQuiet,
            capMs: PAGE_READY_CAPS.observationQuietDeadline,
          },
        )
        .catch(() => false));
    });
  }

  let current = await readProbe();
  if (current === null && !page.isClosed()) {
    // A navigation can destroy the context between the action and the probe.
    // Give the new document the former 1.5 s empty-snapshot window.
    await step("navigation_document", PAGE_READY_CAPS.driveEmpty, async () => {
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: PAGE_READY_CAPS.driveEmpty,
        })
        .catch(() => undefined);
    });
    current = await readProbe();
  }
  if (current === null) return result("navigating");
  if (request.kind === "document") {
    return result(documentLoaded && current.state !== "loading" ? undefined : "document_loading");
  }
  if (current.state === "loading") {
    await step("document_loading", PAGE_READY_CAPS.driveEmpty, async () => {
      await page
        .waitForLoadState("domcontentloaded", {
          timeout: PAGE_READY_CAPS.driveEmpty,
        })
        .catch(() => undefined);
    });
    current = await readProbe();
    if (current === null) return result("navigating");
    if (current.state === "loading") return result("document_loading");
  }
  if (!current.rendered && request.kind === "drive-read") {
    // The old drive gave an empty snapshot three separate 1.5 s windows.
    // This one window returns its reason; the drive can re-enter while its
    // existing budget permits, without capturing or asking the model early.
    await step("drive_empty_content", PAGE_READY_CAPS.driveEmpty, async () => {
      await page
        .waitForFunction(
          (selector: string) => {
            const text = (document.body?.innerText ?? "").trim();
            const renderedText =
              document.body?.querySelector('[aria-busy="true"]') === null &&
              text.length > 0 &&
              !(
                text.length < 120 &&
                !/[\r\n]/.test(text) &&
                /^(?:loading\b|please wait\b|just a moment\b)/i.test(text)
              );
            const visibleControl = Array.from(document.querySelectorAll(selector)).some((node) => {
              if (node.closest('[aria-hidden="true"],[inert]') !== null) return false;
              const box = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return (
                box.width >= 2 &&
                box.height >= 2 &&
                style.visibility !== "hidden" &&
                style.opacity !== "0"
              );
            });
            return renderedText || visibleControl;
          },
          INTERACTIVE_SELECTOR,
          { timeout: PAGE_READY_CAPS.driveEmpty },
        )
        .catch(() => undefined);
    });
    current = await readProbe();
  }
  if (current === null) return result("navigating");
  if (!current.rendered) {
    if (domBusy) return result("hydrating");
    if (networkBusy) return result("network_busy");
    return result("no_rendered_content");
  }
  return result();
}
