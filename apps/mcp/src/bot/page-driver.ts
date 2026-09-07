import type { BrowserContext, Page } from "playwright";
import { OwnedPages } from "./owned-pages.js";

/** One session's page lifetime; never launches or terminates a browser process. */
export class PageDriver {
  page: Page | null = null;

  // The page start() configured with the controller's navigation/captcha
  // handlers. OAuth may temporarily switch `this.page` to a popup, but session
  // reuse must always restore this original page rather than adopting a popup
  // whose lifecycle handlers were never installed.
  primaryPage: Page | null = null;

  // Tabs the PAGE opened (target=_blank / window.open) since the operator armed
  // adoption for an action, oldest first. A real user lands on the tab their
  // click opened — an email magic-link button in Gmail is the case this exists
  // for — so the operator has to follow it too. Reading the link's href instead
  // is not an option: a single-use login token is sealed and must never be
  // handed to the model as text.
  private openedTabs: Page[] = [];

  readonly ownedPages = new OwnedPages((page) => {
    this.trackMainDocument(page);
    this.openedTabs.push(page);
    if (this.openedTabs.length > 8) this.openedTabs.splice(0, this.openedTabs.length - 8);
  });

  private readonly documentSubscriptions = new Map<Page, () => void>();

  private mainDocumentSequence = 0;

  private readonly mainDocumentIdentities = new WeakMap<Page, number>();

  private readonly trackedMainDocumentPages = new WeakSet<Page>();

  // The replay harness owns this context so it can route the storefront from a
  // HAR, then remove that route before checkout becomes live.
  harnessAttachedPage = false;

  // T6/T7 — OAuth handshake bookkeeping. Legacy startOAuth() adopts a
  // popup window as the active page, so keep the product tab parked here
  // until settleAfterOAuth() restores it. The operator's oauth_login action
  // keeps the observed product page active for the click and opens a recovery
  // tab before the provider can redirect or close either OAuth transport.
  oauthProductPage: Page | null = null;

  oauthProviderPage: Page | null = null;

  oauthProviderPageClosed = false;

  oauthCompletionPage: Page | null = null;

  oauthTerminalCompletionUrl: string | null = null;
  constructor(
    private readonly getContext: () => BrowserContext | null,
    private readonly humanize: boolean,
  ) {}
  private get context(): BrowserContext | null {
    return this.getContext();
  }
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  trackMainDocument(page: Page): void {
    if (page.isClosed() || this.trackedMainDocumentPages.has(page)) return;
    this.trackedMainDocumentPages.add(page);
    this.mainDocumentIdentities.set(page, ++this.mainDocumentSequence);
    // A REPLACED main document advances the identity; a same-document History
    // API navigation does not. Playwright emits `framenavigated` for both, so
    // keying on it made every `history.replaceState` inside an SPA checkout
    // retire every operator ref mid-form — the identity churned faster than a
    // multi-field address block could be filled. `domcontentloaded` fires once
    // per real main-frame document (playwright's client `Frame` gates it on
    // `!this._parentFrame`), which is exactly the document-replacement signal.
    // A same-document route change to a genuinely different logical page is
    // still caught by the observation epoch's normalized origin+pathname fold
    // (compactV2EpochDoc), which is the backstop this narrowing relies on.
    const onDocument = (): void => {
      this.mainDocumentIdentities.set(page, ++this.mainDocumentSequence);
    };
    const dispose = (): void => {
      page.off("domcontentloaded", onDocument);
      page.off("close", dispose);
      this.documentSubscriptions.delete(page);
      this.trackedMainDocumentPages.delete(page);
    };
    this.documentSubscriptions.set(page, dispose);
    page.on("domcontentloaded", onDocument);
    page.on("close", dispose);
  }

  mainDocumentIdentity(page: Page | null = this.page): string {
    if (page === null) return "none";
    this.trackMainDocument(page);
    return String(this.mainDocumentIdentities.get(page));
  }

  // Register only explicitly created primary/recovery pages. Popup enrollment
  // follows their creation-time opener events, never context-wide page events.
  trackOpenedTabs(page: Page): void {
    this.ownedPages.register(page);
    this.trackMainDocument(page);
  }

  // URL of the active page (the OAuth page mid-handshake, the product
  // page otherwise). Cheap — no screenshot, unlike getState().
  currentUrl(): string {
    return this.page !== null ? this.page.url() : "";
  }

  recoverActivePage(): boolean {
    return this.adoptLivePage();
  }

  // ───────────── new-tab adoption ─────────────
  //
  // Arm adoption immediately BEFORE an action that may open a tab. Anything
  // already queued belonged to an earlier action and is not this action's to
  // follow.
  armOpenedTabAdoption(): void {
    this.openedTabs.length = 0;
  }

  // Adopt the newest live tab opened since armOpenedTabAdoption() as the active
  // page, so the next observe/act reads the tab the click actually opened.
  // Returns the adopted URL, or null when the action opened no followable tab.
  //
  // `graceMs` covers the window between the click returning and Playwright
  // delivering the context "page" event; a caller that has already waited for
  // the page to settle passes 0 and just drains what arrived.
  async adoptOpenedTab(graceMs = 0): Promise<string | null> {
    const deadline = Date.now() + Math.max(0, graceMs);
    let candidate = this.takeFollowableTab();
    while (candidate === null && Date.now() < deadline) {
      await this.sleep(50);
      candidate = this.takeFollowableTab();
    }
    if (candidate === null) return null;
    this.openedTabs.length = 0;
    // A window.open target starts at about:blank and is navigated a tick later.
    // Adopting it while blank would report an empty page to the host, so wait
    // (bounded) for the document it was opened for.
    const blank = (url: string): boolean =>
      url === "" || url === "about:blank" || url === "about:srcdoc";
    for (let i = 0; i < 40 && !candidate.isClosed() && blank(candidate.url()); i++) {
      await this.sleep(50);
    }
    if (!this.ownedPages.has(candidate)) return null;
    this.page = candidate;
    this.trackMainDocument(candidate);
    await candidate.bringToFront().catch(() => undefined);
    await candidate
      .waitForLoadState("domcontentloaded", { timeout: 15_000 })
      .catch(() => undefined);
    return candidate.isClosed() ? null : candidate.url();
  }

  // Newest owned popup the operator may follow. Explicit primary/recovery
  // pages never enter the queue; the active page and OAuth transports retain
  // their existing lifecycle handling.
  private takeFollowableTab(): Page | null {
    for (let i = this.openedTabs.length - 1; i >= 0; i--) {
      const tab = this.openedTabs[i]!;
      if (!this.ownedPages.has(tab)) continue;
      if (
        tab === this.page ||
        tab === this.primaryPage ||
        tab === this.oauthProductPage ||
        tab === this.oauthProviderPage
      ) {
        continue;
      }
      return tab;
    }
    return null;
  }

  adoptLivePage(): boolean {
    if (this.page !== null && this.ownedPages.has(this.page)) return true;
    if (this.context === null) return false;
    const pages = this.ownedPages.live();
    if (pages.length === 0) return false;
    const product =
      this.oauthProductPage !== null && this.ownedPages.has(this.oauthProductPage)
        ? this.oauthProductPage
        : null;
    const nonAuth = [...pages]
      .reverse()
      .find(
        (p) =>
          !/accounts\.google\.com|github\.com\/login|login\.microsoftonline\.com/i.test(p.url()),
      );
    this.page = nonAuth ?? product ?? pages[pages.length - 1] ?? null;
    return this.page !== null;
  }

  async goto(url: string): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    // Retry transient network/proxy drops. A residential SOCKS tunnel
    // intermittently resets a connection mid-navigation (Chrome surfaces
    // net::ERR_SOCKS_CONNECTION_FAILED / ERR_CONNECTION_RESET / ERR_NETWORK_
    // CHANGED / ERR_TIMED_OUT), especially on heavy onboarding pages that
    // open many subresource connections at once (algolia's dashboard_setup).
    // The host is reachable on the next attempt — a single goto failure
    // shouldn't fail the whole signup. Only retry these connection-level
    // errors; HTTP statuses and selector/logic errors fall straight through.
    // net::ERR_ABORTED — a navigation superseded by a redirect/JS-nav during
    // the domcontentloaded wait. Usually transient (a redirect race on the
    // first hit of an auth-gated portal — MEASURED 2026-06-11: defang's
    // portal.defang.io aborted on the initial goto); a retry lands the
    // settled page. Distinct from ERR_CONNECTION_ABORTED (a dropped socket).
    const TRANSIENT_NET =
      /ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_(?:RESET|CLOSED|FAILED|ABORTED)|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|net::ERR_EMPTY_RESPONSE|net::ERR_ABORTED/i;
    const MAX_GOTO_ATTEMPTS = 3;
    const sameOriginPathAndSearch = (a: string, b: string): boolean => {
      try {
        const left = new URL(a);
        const right = new URL(b);
        return (
          left.origin === right.origin &&
          left.pathname === right.pathname &&
          left.search === right.search
        );
      } catch {
        return false;
      }
    };
    const landedAuthGateForTarget = (landedRaw: string, targetRaw: string): boolean => {
      try {
        const landed = new URL(landedRaw);
        const target = new URL(targetRaw);
        if (landed.origin !== target.origin) return false;
        return /\/(?:sign[_-]?in|login|log[_-]?in|auth)(?:\/|$)/i.test(landed.pathname);
      } catch {
        return false;
      }
    };
    for (let attempt = 1; ; attempt++) {
      try {
        await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        // A SOCKS/connection drop does NOT always throw: Chrome resolves
        // domcontentloaded on its own `chrome-error://chromewebdata/`
        // interstitial and goto returns cleanly. The bot then ran the whole
        // planner on a dead error page and gave up after one round (MEASURED
        // 2026-06-11: galileo/lancedb landed on chrome-error with the app
        // host as the title, never retried). Treat a chrome-error landing as
        // the same transient class and retry it like a thrown net error.
        const landed = this.page.url();
        if (landed.startsWith("chrome-error://")) {
          if (attempt >= MAX_GOTO_ATTEMPTS) {
            throw new Error(
              `net::navigation landed on a Chrome error page for ${url} ` +
                `after ${attempt} attempts (transient proxy/host failure)`,
            );
          }
          await this.sleep(1500 * attempt);
          continue;
        }
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Some client-routed apps commit the address bar to the requested SPA
        // route but never fire the lifecycle event Playwright is waiting for.
        // Treat that as a successful navigation: callers immediately inspect
        // the DOM and have their own element-level waits.
        if (/Timeout \d+ms exceeded/i.test(msg)) {
          await this.sleep(500);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
          await this.page
            .waitForURL((landed) => sameOriginPathAndSearch(landed.toString(), url), {
              timeout: 5000,
            })
            .then(() => undefined)
            .catch(() => undefined);
          if (sameOriginPathAndSearch(this.page.url(), url)) break;
          if (landedAuthGateForTarget(this.page.url(), url)) break;
        }
        if (attempt >= MAX_GOTO_ATTEMPTS || !TRANSIENT_NET.test(msg)) throw err;
        // Linear backoff — give the tunnel a moment to recover a slot.
        await this.sleep(1500 * attempt);
      }
    }
    // Post-load dwell. Cloudflare/reCAPTCHA scoring runs JS that
    // collects behavior signals over a window (typically 500-2000ms);
    // landing on a page and immediately interacting reads as bot-like.
    // The "dwell" gives the scoring window enough wall-clock to settle
    // and also gives any deferred JS time to register event listeners
    // we'll later fire.
    if (this.humanize) {
      await this.sleep(rand(800, 2000));
    }
  }

  // Reload the current page. Used by the post-verify flow to make a SPA
  // re-read a server-side state change (email verified) that the client
  // hasn't picked up yet. Best-effort: a reload failure is non-fatal — the
  // caller re-reads the page state regardless.
  async reload(): Promise<void> {
    if (!this.page) throw new Error("Browser not started");
    try {
      await this.page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch {
      // reload failed (slow SPA / transient) — caller re-inspects anyway
    }
  }
  disposeRegistrations(): void {
    this.ownedPages.dispose();
    for (const dispose of this.documentSubscriptions.values()) dispose();
    this.openedTabs.length = 0;
  }
}
function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}
