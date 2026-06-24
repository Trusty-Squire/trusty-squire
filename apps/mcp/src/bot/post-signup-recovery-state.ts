export const MAX_UPSTREAM_BLIP_RETRIES = 8;
export const MAX_PREMATURE_DONE_FALLBACKS = 3;
export const MAX_POST_VERIFY_NAVIGATES = 8;

export interface PostSignupActionEffect {
  kind: string;
  pageUnchanged: boolean;
  selector: string | null;
}

// Mutable recovery memory for one post-signup planner loop. This deliberately
// stores state only; browser reads/writes and failure decisions stay in
// SignupAgent until they can be extracted behind smaller ports.
export class PostSignupRecoveryState {
  consecutiveOauthLoginPageRounds = 0;
  oauthBounceReloadTried = false;

  shellStreak = 0;
  shellRootNavTried = false;

  planFailures = 0;
  upstreamBlipRetries = 0;
  consecutiveFailedExtracts = 0;

  prevSignature: string | null = null;
  prevInventorySize = -1;
  clickSelectorsSinceInventoryChange = new Set<string>();

  consecutiveWaits = 0;
  consecutiveSameUrlWaits = 0;
  lastWaitUrl: string | null = null;
  waitReloadTried = false;

  prevNavigateFromUrl: string | null = null;

  prevContentSig: string | null = null;
  lastActionKind: string | null = null;
  lastActionSelector: string | null = null;
  uniqueNameRetried = false;
  forcedAdvanceTried = false;
  actionEffects: PostSignupActionEffect[] = [];

  stuckFiresAtUrl = 0;
  lastStuckFireUrl: string | null = null;
  triedFallbackUrls = new Set<string>();
  clickedKeysLinks = new Set<string>();
  clickedScopeLinks = new Set<string>();
  prematureDoneFallbacks = 0;

  navigateCount = 0;
  deadUrls = new Set<string>();
  lastNavigatedTo: string | null = null;
  triedWizardForward = new Set<string>();
  triedWizardLeafChoices = new Set<string>();
  // Once true, the STALLED-wizard escape-to-dashboard has been attempted — a
  // re-presenting onboarding wizard whose clicks don't register overlays the
  // real product dashboard, so we navigate to a settings/keys/home nav link to
  // reach the credential surface behind it (cloudinary /app/welcome).
  triedWizardEscape = false;
}

export interface RecoveryClickableElement {
  tag: string;
  role: string | null;
  interactedThisRun?: boolean | undefined;
  visibleText: string | null;
  ariaLabel: string | null;
  labelText: string | null;
  selector: string;
}

export type NavigateRecoveryDecision =
  | { kind: "not_navigate" }
  | { kind: "replan"; message: string; hint: string }
  | { kind: "break"; message: string; doneReason: string }
  | { kind: "execute" };

export interface NavigateRecoveryInput {
  url: string;
  targetUrl: string;
  inventory: readonly RecoveryClickableElement[];
}

export type WaitRecoveryDecision =
  | { kind: "not_wait" }
  | { kind: "continue" }
  | { kind: "reload"; message: string; url: string }
  | { kind: "break"; message: string; doneReason: string };

export interface WaitRecoveryInput {
  url: string;
  inventoryCount: number;
  reason: string;
}

export type ShellRecoveryDecision =
  | { kind: "settle"; message: string }
  | { kind: "navigate_root"; message: string; url: string };

export interface ShellRecoveryInput {
  round: number;
  path: string;
  rootUrl: string;
  currentUrl: string;
}

export type OAuthLoginPageRecoveryDecision =
  | { kind: "clear" }
  | { kind: "continue" }
  | { kind: "reload"; message: string; url: string }
  | { kind: "fail"; message: string; rounds: number };

export interface OAuthLoginPageRecoveryInput {
  isOAuthRun: boolean;
  isLoginPage: boolean;
  path: string;
  rootUrl: string;
  currentUrl: string;
}

export type FailedExtractRecoveryDecision =
  | { kind: "masked_or_truncated"; hint: string }
  | { kind: "replan"; message: string; hint: string };

export class PostSignupRecoveryFlow {
  constructor(private readonly state: PostSignupRecoveryState) {}

  recordNonNavigate(): void {
    this.state.prevNavigateFromUrl = null;
  }

  recordNavigateExecution(fromUrl: string, targetUrl: string): void {
    this.state.prevNavigateFromUrl = fromUrl;
    this.state.lastNavigatedTo = targetUrl;
  }

  decideNavigate(input: NavigateRecoveryInput): NavigateRecoveryDecision {
    if (this.state.prevNavigateFromUrl === input.url) {
      const candidateClicks = input.inventory
        .filter(
          (element) =>
            (element.tag === "button" ||
              element.tag === "a" ||
              element.role === "button" ||
              element.role === "link") &&
            element.interactedThisRun !== true,
        )
        .slice(0, 8)
        .map((element) => {
          const label =
            element.visibleText ??
            element.ariaLabel ??
            element.labelText ??
            "(no label)";
          return `  - ${JSON.stringify(label)} → selector=${element.selector}`;
        });
      this.state.prevNavigateFromUrl = null;
      return {
        kind: "replan",
        message: `Post-verify: navigate did not advance the page (URL still ${input.url}) — forcing a click on an inventory element.`,
        hint:
          `Your last 'navigate' to a guessed URL did NOT advance the page — the service ` +
          `redirected you back to ${input.url}. STOP navigating and CLICK an element ` +
          `from the current inventory below. The page is gating you behind an onboarding ` +
          `CTA (e.g. "Get started", "Continue", "Activate") or a setup step that must be ` +
          `clicked before the API console becomes reachable.` +
          (candidateClicks.length > 0
            ? `\n\nClickable elements you haven't tried:\n${candidateClicks.join("\n")}`
            : ""),
      };
    }

    this.state.navigateCount += 1;
    if (this.state.navigateCount <= MAX_POST_VERIFY_NAVIGATES) {
      return { kind: "execute" };
    }

    const clickable = input.inventory.filter(
      (element) => element.tag === "button" || element.tag === "a",
    );
    if (
      clickable.length > 0 &&
      this.state.navigateCount <= MAX_POST_VERIFY_NAVIGATES + 2
    ) {
      return {
        kind: "replan",
        message:
          `Post-verify: navigate budget (${MAX_POST_VERIFY_NAVIGATES}) exhausted — ` +
          `forcing a click on the current page instead of guessing more URLs.`,
        hint:
          `You have navigated ${this.state.navigateCount} times without reaching an API-key page. ` +
          `STOP navigating to guessed URLs. CLICK an element from the inventory below ` +
          `to advance the onboarding/dashboard, or emit 'done' if there is genuinely no ` +
          `key affordance here.`,
      };
    }

    return {
      kind: "break",
      message:
        `Post-verify: navigate budget exhausted (${this.state.navigateCount}) ` +
        `with no credential — breaking out instead of burning the run deadline.`,
      doneReason:
        `[stuck_loop] post-verify exhausted the navigate budget (${this.state.navigateCount} navigates) without ` +
        `reaching a credential page — the key is behind onboarding/URL the planner can't address.`,
    };
  }

  decideWait(input: WaitRecoveryInput): WaitRecoveryDecision {
    if (input.inventoryCount === 0) {
      this.state.consecutiveWaits += 1;
      if (this.state.consecutiveWaits >= 3) {
        return {
          kind: "break",
          doneReason:
            `post-OAuth landing rendered 0 interactive elements for ${this.state.consecutiveWaits} rounds — ` +
            `most recent planner reason: ${input.reason}`,
          message:
            `Post-verify: wait-loop on an empty page (${this.state.consecutiveWaits} consecutive rounds, 0 elements) — breaking out.`,
        };
      }
    } else {
      this.state.consecutiveWaits = 0;
    }

    if (input.url === this.state.lastWaitUrl) {
      this.state.consecutiveSameUrlWaits += 1;
    } else {
      this.state.consecutiveSameUrlWaits = 1;
      this.state.lastWaitUrl = input.url;
    }

    if (
      this.state.consecutiveSameUrlWaits === 4 &&
      !this.state.waitReloadTried
    ) {
      this.state.waitReloadTried = true;
      return {
        kind: "reload",
        url: input.url,
        message:
          `Post-verify: ${this.state.consecutiveSameUrlWaits} consecutive waits on ${input.url} — ` +
          `reloading once to unstick a hung post-OAuth redirect.`,
      };
    }

    if (this.state.consecutiveSameUrlWaits >= 6) {
      return {
        kind: "break",
        doneReason:
          `post-OAuth interstitial (${input.url}) never resolved after ${this.state.consecutiveSameUrlWaits} waits — ` +
          `likely a hung redirect or onboarding bootstrap for a freshly-created account`,
        message:
          `Post-verify: wait-loop on ${input.url} (${this.state.consecutiveSameUrlWaits} rounds, page has elements but never advances) — breaking out.`,
      };
    }

    return { kind: "continue" };
  }

  recordNonWait(): void {
    this.state.consecutiveWaits = 0;
    this.state.consecutiveSameUrlWaits = 0;
    this.state.lastWaitUrl = null;
  }

  decideShell(input: ShellRecoveryInput): ShellRecoveryDecision {
    this.state.shellStreak += 1;
    if (this.state.shellStreak >= 2 && !this.state.shellRootNavTried) {
      this.state.shellRootNavTried = true;
      return {
        kind: "navigate_root",
        url: input.rootUrl,
        message:
          `Post-verify round ${input.round}: ${input.path} read as a loading shell for ` +
          `${this.state.shellStreak} consecutive rounds — navigating to origin root once before bailing.`,
      };
    }

    return {
      kind: "settle",
      message:
        `Post-verify round ${input.round}: ${input.path} is a loading shell ` +
        `(streak ${this.state.shellStreak}) — letting the SPA settle one more round`,
    };
  }

  recordShellRecovered(): void {
    this.state.shellStreak = 0;
  }

  recordNoShell(): void {
    this.state.shellStreak = 0;
  }

  decideOAuthLoginPage(
    input: OAuthLoginPageRecoveryInput,
  ): OAuthLoginPageRecoveryDecision {
    if (!input.isOAuthRun || !input.isLoginPage) {
      this.state.consecutiveOauthLoginPageRounds = 0;
      return { kind: "clear" };
    }

    this.state.consecutiveOauthLoginPageRounds += 1;
    if (
      this.state.consecutiveOauthLoginPageRounds >= 3 &&
      !this.state.oauthBounceReloadTried
    ) {
      this.state.oauthBounceReloadTried = true;
      const rounds = this.state.consecutiveOauthLoginPageRounds;
      this.state.consecutiveOauthLoginPageRounds = 0;
      return {
        kind: "reload",
        url: input.rootUrl,
        message:
          `Post-verify: OAuth run still on a login page (${input.path}) for ` +
          `${rounds} rounds — reloading once before bailing ` +
          `(a set session cookie often lands the dashboard on reload).`,
      };
    }

    if (this.state.consecutiveOauthLoginPageRounds >= 3) {
      return {
        kind: "fail",
        rounds: this.state.consecutiveOauthLoginPageRounds,
        message:
          `Post-verify: OAuth run still on a login page (${input.path}) for ` +
          `${this.state.consecutiveOauthLoginPageRounds} rounds (incl. a reload) — the OAuth callback never persisted; bailing.`,
      };
    }

    return { kind: "continue" };
  }

  recordExtractionSuccess(): void {
    this.state.consecutiveFailedExtracts = 0;
  }

  decideFailedExtract(): FailedExtractRecoveryDecision {
    this.state.consecutiveFailedExtracts += 1;
    if (this.state.consecutiveFailedExtracts >= 2) {
      const failures = this.state.consecutiveFailedExtracts;
      this.state.consecutiveFailedExtracts = 0;
      return {
        kind: "replan",
        message:
          `Post-verify: ${failures} consecutive failed extracts ` +
          `on a page the planner says shows a token — the value's shape is not ` +
          `in this build's regex library. Re-planning off extract.`,
        hint:
          "Your last TWO 'extract' attempts returned NO key, even though you " +
          "said the token is visible. The token's SHAPE is not one this " +
          "extractor recognises (e.g. a bare UUID with no 'API key:' label " +
          "nearby). Do NOT issue another 'extract'. Instead: " +
          "(1) {\"kind\":\"click\"} a 'Copy' / 'Copy token' / 'Copy to clipboard' " +
          "button near the token — the clipboard path bypasses the regex. " +
          "(2) If no Copy button exists, issue {\"kind\":\"done\"} — the user " +
          "will copy the token manually from the screenshot.",
      };
    }

    return {
      kind: "masked_or_truncated",
      hint:
        "Your last 'extract' found NO key — the key text on the page is " +
        "masked or truncated (e.g. shows '...' or dots). A masked existing " +
        "key cannot be extracted. Click 'Create API Key' / 'New API Key' to " +
        "generate a fresh one — its full value is shown once, on creation.",
    };
  }
}
