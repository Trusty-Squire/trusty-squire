// oauth-detect.ts — browser-free inventory predicates for the OAuth-first
// signup path: find a "Sign in with <provider>" affordance, and decide whether
// a page is already an authenticated (post-login) surface. Carved out of
// agent.ts (the retired universal-bot monolith); skill replay uses these to
// route between OAuth, form-fill, and key-extraction.

import type { InteractiveElement } from "./browser.js";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth-providers.js";

export function detectAlreadySignedIn(args: {
  inventory: readonly InteractiveElement[];
  url: string;
}): boolean {
  const { inventory, url } = args;

  // Precondition: any visible credential input → not authenticated.
  const hasCredentialInput = inventory.some(
    (e) =>
      e.tag === "input" &&
      (e.type === "email" || e.type === "password" || e.type === "tel"),
  );
  if (hasCredentialInput) return false;

  // Signal 0 — a strong post-login URL path. An onboarding /
  // getting-started / welcome route is only reachable AFTER you're
  // authenticated (you cannot see a "you're all set, next steps" wizard
  // without a session), so the URL alone is conclusive here — unlike the
  // weaker dashboard paths in Signal 3, no paired creation-CTA is needed.
  // last9 lands the bot on /v2/organizations/<slug>/getting-started with
  // its Google session already active; its buttons ("Choose your region",
  // "You're all set! Next steps", "Upgrade Plan") matched none of the CTA
  // vocabularies below, so it used to bail `oauth_required` — claiming
  // "only OAuth/SSO signup, no email/password form" while the bot was in
  // fact fully signed in. The precondition above already ruled out a
  // signup chooser (no credential input).
  // ...UNLESS the page still presents a signup/OAuth chooser (a
  // "Continue with Google" button or a bare "Sign up"/"Log in"). Some
  // services route the login chooser through an /onboarding-style URL; if
  // a provider button is visible, the bot must OAuth via it, not treat the
  // page as already-authenticated. (PostHog TS-1923.)
  const hasSignupAffordance = inventory.some((e) => {
    const t = `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    return (
      /\b(?:continue with|sign ?up with|sign ?in with|log ?in with|with (?:google|github|gitlab|microsoft|apple))\b/.test(
        t,
      ) || /^(?:sign ?up|sign ?in|log ?in|create (?:an )?account)$/.test(t)
    );
  });


  const visibleTextOf = (e: InteractiveElement): string =>
    `${e.visibleText ?? ""} ${e.ariaLabel ?? ""}`.trim();

  const RESOURCE_CREATION_CTA =
    /^\s*(?:\+\s*)?(?:new\s+(?:project|workspace|team|app|site|deployment|api\s*key|database|cluster|instance|service|index|environment)|create(?:\s+(?:new|a|an|project|workspace|database|cluster|instance|deployment|app|service|index|environment))?|get\s+started\s+by\s+sett?ing\s+up\s+(?:a|an)?\s*.*\b(?:project|workspace|app|application|service|database|cluster|index)\b|sett?ing\s+up\s+(?:a|an)?\s*.*\b(?:project|workspace|app|application|service|database|cluster|index)\b)/i;
  const hasResourceCreationCta = inventory.some((e) =>
    RESOURCE_CREATION_CTA.test(visibleTextOf(e)),
  );
  const ONBOARDING_CHROME =
    /\b(?:set up your first|create your project|get started by sett?ing up|welcome to|import documents|make a search|don'?t show me again|bring me home|setup checklist|onboarding)\b/i;
  const hasOnboardingChrome = inventory.some((e) =>
    ONBOARDING_CHROME.test(visibleTextOf(e)),
  );
  if (!hasSignupAffordance && hasResourceCreationCta && hasOnboardingChrome) {
    return true;
  }

  try {
    if (
      !hasSignupAffordance &&
      /\/(?:getting-started|get-started|onboarding|welcome)(?:\/|$)/i.test(
        new URL(url).pathname,
      )
    ) {
      return true;
    }
  } catch {
    // malformed URL — fall through to the other signals
  }

  // Signal 1 — strict nav-keyword match (the canonical Sentry-class case).
  // STRONG markers (sign out / log out) PROVE a session — you can't sign out if
  // you're not signed in — so they fire even next to a decoration "Continue with
  // Google" (account-linking) button. WEAK markers (dashboard / projects /
  // settings / …) are ordinary nav labels that ALSO appear on a logged-out
  // marketing or /login page, so they must NOT override a visible auth gate:
  // gate them on !hasSignupAffordance. Without this split, northflank's /login
  // (which renders "Continue with Google" alongside "Projects"/"Settings") was
  // mis-read as signed-in → the replay skipped click_oauth_button → the fresh
  // robot never logged in and bailed needs_login deep in the flow (MEASURED
  // 2026-06-24).
  const STRONG_AUTH_KEYWORDS = /^\s*(?:sign out|log out)\s*$/i;
  const WEAK_AUTH_KEYWORDS =
    /^\s*(?:dashboard|projects|settings|profile|my account|account settings|workspaces)\s*$/i;
  const textOf = (e: InteractiveElement): string => (e.visibleText ?? e.ariaLabel ?? "").trim();
  if (inventory.some((e) => STRONG_AUTH_KEYWORDS.test(textOf(e)))) {
    return true;
  }
  if (!hasSignupAffordance && inventory.some((e) => WEAK_AUTH_KEYWORDS.test(textOf(e)))) {
    return true;
  }

  // Signal 2 — billing / trial widget. Patterns observed in the wild:
  //   "28 days or $5.00 leftTrial" (Railway, no separator)
  //   "Trial" (most SaaS)
  //   "$N left" / "N days left" / "remaining"
  const BILLING =
    /(?:\$\d+(?:\.\d+)?\s*(?:left|remaining)|\d+\s*days?\s*(?:left|remaining|trial)|\btrial\b)/i;
  if (
    !hasSignupAffordance &&
    inventory.some((e) => BILLING.test(visibleTextOf(e)))
  ) {
    return true;
  }

  // Signal 3 — dashboard-route URL + creation CTA visible.
  // The URL gate is conservative: a path that READS as dashboard,
  // not /login or /signup or /. Combined with a creation CTA
  // ("New project", "Create workspace", "+ New") it pins the
  // page as a post-login surface.
  let dashboardyPath = false;
  try {
    const parsed = new URL(url);
    // rc.37 — widened the dashboard-path allowlist after the rc.35
    // sweep showed Upstash's post-OAuth landing was /redis (the
    // product-segment route, not a generic /dashboard). Added
    // /redis, /kafka, /vector, /cluster, /databases?, /instances?,
    // /apps?, /deployments?, /services? — all common product-name
    // routes that almost always indicate authenticated state.
    // An /organizations/<…> or /orgs/<…> prefix is an authenticated-only
    // marker: a logged-OUT visitor never has an organization-scoped route.
    // pinecone's post-OAuth plan-chooser sits at
    // app.pinecone.io/organizations/registration — the trailing
    // "registration" tripped the register-exclusion below and the bot, fully
    // signed in via the operator's existing Google-linked account, bailed
    // no_signup_link instead of routing to key-extraction (MEASURED
    // 2026-06-11: pinecone account was created May 25, so every later run
    // lands here authenticated). An org-prefixed path forces dashboardy and
    // bypasses the auth-route exclusion.
    const hasOrgPrefix = /\/(?:organizations?|orgs?)\//i.test(parsed.pathname);
    dashboardyPath =
      hasOrgPrefix ||
      (/\/(?:new|dashboard|projects?|account|settings|workspace|home|admin|redis|kafka|vector|cluster|databases?|instances?|apps?|deployments?|services?|onboarding|welcome|getting-started|get-started|setup)(?:\/|$)/i.test(
        parsed.pathname,
      ) && !/\/(?:signup|sign-up|register|login|sign-in|signin)/i.test(parsed.pathname));
  } catch {
    // Malformed URL — skip URL signal.
  }
  if (dashboardyPath) {
    // rc.37 — widened the creation-CTA vocabulary to include the
    // dashboard-y "Create <product-noun>" pattern. Upstash's
    // dashboard CTA reads "Create Database"; Convex / Neon /
    // PlanetScale / similar all use this shape ("Create cluster",
    // "Create instance", "Create deployment"). Without this the
    // bot's F17 already-signed-in path fell through to form-fill
    // and the planner clicked the CTA thinking it was a signup
    // submit button.
    if (
      inventory.some((e) => {
        const t = e.visibleText ?? e.ariaLabel ?? "";
        return RESOURCE_CREATION_CTA.test(t.trim());
      })
    ) {
      return true;
    }

    // 0.8.2-rc.5 — PostHog-class onboarding wizard. When the URL is
    // dashboard-y (path like /project/<id>/onboarding) and the page
    // shows project-picker / account-menu / onboarding-skip
    // affordances WITHOUT a credential input or OAuth provider button,
    // the user is authenticated and the wizard is interstitial. The
    // rc.3 overnight run for posthog landed exactly here and bailed
    // `oauth_required` because the inventory had only:
    //   - "Default project" (project picker)
    //   - "BBento" (account avatar toggle)
    //   - "Hand off setup" (skip-onboarding affordance)
    //
    // Detect this shape via a second-tier signal set. Conservative —
    // we already gated on "no credential inputs" and "dashboardyPath",
    // so a true signup chooser (which has neither of those AND the
    // path is /signup or /login) cannot reach this branch.
    const POST_AUTH_AFFORDANCE =
      /^\s*(?:hand\s*off\s*setup|skip\s*(?:onboarding|setup|for\s*now)|invite\s*(?:teammates|members|your\s*team)|set\s*up\s*billing|finish\s*setup|get\s*started|continue\s*to\s*(?:dashboard|app|console))\s*$/i;
    // Workspace / project / org picker shape. We pattern-match
    // generously because PostHog's reads "Default project" but other
    // SaaS dashboards read "My workspace" / "Acme org" / similar. The
    // structural cue is "button with one of the workspace-noun words"
    // — see TS-1923 (PostHog rc.3 regression).
    const WORKSPACE_PICKER =
      /\b(?:workspace|workspaces|project(?:s)?|organization|organizations|team(?:s)?)\b/i;
    const hasPostAuthAffordance = inventory.some((e) =>
      POST_AUTH_AFFORDANCE.test((e.visibleText ?? e.ariaLabel ?? "").trim()),
    );
    if (hasPostAuthAffordance) {
      // Single signal — the skip-onboarding / handoff verb is strong
      // enough on its own. No login page ever offers "Hand off setup".
      return true;
    }
    // Weaker pair: a workspace-picker shape AND the page lacks a
    // primary call-to-action that reads as signup ("Continue with
    // Google", "Sign up", etc.). Used as a backstop for SPA dashboards
    // whose only visible buttons are picker toggles.
    const hasWorkspacePicker = inventory.some((e) =>
      WORKSPACE_PICKER.test((e.visibleText ?? e.ariaLabel ?? "").trim()),
    );
    const hasSignupOrOAuthAffordance = inventory.some((e) => {
      const t = (e.visibleText ?? e.ariaLabel ?? "").trim();
      return /\b(?:sign[\s-]*up|signup|continue\s+with|log\s+in\s+with|sign\s+in\s+with)\b/i.test(
        t,
      );
    });
    if (hasWorkspacePicker && !hasSignupOrOAuthAffordance) {
      return true;
    }
    // 0.8.3-rc.1 — onboarding-wizard step shape. When the URL clearly
    // names an onboarding path (/onboarding, /welcome, /getting-started,
    // /setup) AND the page has a Next/Continue/Skip/Submit button AND
    // does NOT have any credential input (caught above) AND does NOT
    // have a Sign-up/Continue-with affordance (i.e. it's not a CHOICE
    // between login and signup), the page is mid-onboarding for an
    // already-authenticated user. Mixpanel hits this when a previous
    // run created the account but didn't finish the multi-step
    // onboarding — the bot returns and lands directly on /onboarding.
    let onboardingPath = false;
    try {
      onboardingPath =
        /\/(?:onboarding|welcome|getting-started|get-started|setup)(?:\/|$)/i.test(
          new URL(url).pathname,
        );
    } catch {
      // Malformed URL — skip
    }
    if (onboardingPath && !hasSignupOrOAuthAffordance) {
      const WIZARD_STEP_BTN =
        /^\s*(?:next|continue|submit|skip(?:\s+for\s+now)?|finish|done)\s*$/i;
      const hasWizardStepButton = inventory.some((e) => {
        const t = (e.visibleText ?? e.ariaLabel ?? "").trim();
        return WIZARD_STEP_BTN.test(t);
      });
      if (hasWizardStepButton) return true;
    }
  }

  return false;
}

// rc.12 — sanity-cap the element's own visible text. A real sign-in
// button is short ("Continue with Google" = 19 chars, "Sign in with
// GitHub" = 19). When the element's visibleText runs longer than the
// cap below, it is wrapping unrelated content — typically a marketing
// card with a small provider logo nested inside. The OpenRouter case:
// an <a> wrapping a model card whose textContent reads "anthropic/
// claude-opus-4.7Model routing visualization…" and whose descendant
// tree contains an <img alt="Google"> for a tiny G icon. The iconLabel
// path then fired against the wrong element. Capping at 60 chars also
// gates path 2 to truly icon-only elements (no own visible text) so a
// card wrapper with one stray <img alt> can never match.
const MAX_OAUTH_BUTTON_TEXT_CHARS = 60;
function normalizeOAuthButtonText(text: string, keyword: string): string {
  return text.replace(new RegExp(`(${keyword})(?=[A-Z])`, "gi"), "$1 ");
}

// Find a "Sign in with <provider>" affordance in the page inventory —
// the entry point for the OAuth-first path (T6/T13). Three signals, in
// confidence order — derived from a live sweep where the text-only
// heuristic missed real buttons:
//   1. href — an <a> whose link routes through the provider's OAuth
//      endpoint (/identity/login/google, /auth/github/callback, …).
//      Unambiguous: a marketing link to policies.google.com does not.
//   2. iconLabel — an icon-only button with no text at all, named only
//      by a descendant <img alt="Google"> / <svg><title> (Mistral).
//   3. text + an auth verb — "Continue with Google", "Sign up with
//      GitHub". The auth verb is what keeps a bare "Google" nav link
//      or "Google's Privacy Policy" out.
// Returns null when the page has no such affordance — the planner then
// falls back to form-fill.
export function findOAuthButton(
  inventory: readonly InteractiveElement[],
  provider: OAuthProviderId,
): InteractiveElement | null {
  const keyword = OAUTH_PROVIDERS[provider].buttonKeyword;
  const keywordRe = new RegExp(`\\b${keyword}\\b`);
  const hrefRe = new RegExp(
    `(?:login|signin|sign-in|auth|oauth|connect|sso)[/_-]*${keyword}` +
      `|${keyword}[/_-]*(?:login|signin|auth|oauth|connect)`,
    "i",
  );
  for (const e of inventory) {
    const isButtonish =
      e.tag === "button" ||
      e.tag === "a" ||
      e.role === "button" ||
      e.type === "submit" ||
      e.type === "button";
    if (!isButtonish) continue;
    const visibleText = (e.visibleText ?? "").trim();
    if (visibleText.length > MAX_OAUTH_BUTTON_TEXT_CHARS) continue;
    // 1. An <a> whose href routes through the provider's OAuth endpoint.
    const href = (e.href ?? "").toLowerCase();
    if (href.length > 0 && hrefRe.test(href)) return e;
    // 2. Icon-only (logo) button — named only by a descendant img/svg.
    //    Truly-empty visibleText is the clean case. But a logo button whose
    //    <svg> carries a <title>GitHub</title> LEAKS that title into
    //    textContent (northflank renders "GitHubGitHub" — doubled, which
    //    also defeats the \bgithub\b match in path 3), so it isn't strictly
    //    empty. Treat it as icon-only too WHEN its visible text is nothing
    //    but the provider name (any number of times): strip every keyword
    //    occurrence and require no residue. A nav link like "GitHub's
    //    Privacy Policy" leaves residue and is correctly rejected. The
    //    iconLabel must still independently name the provider, so a stray
    //    one-word label can't false-positive.
    const kw = keyword.toLowerCase();
    const residue = visibleText
      .toLowerCase()
      .split(kw)
      .join("")
      .replace(/[\s·|/–-]+/g, "");
    const isLogoOnly = visibleText.length === 0 || residue.length === 0;
    if (isLogoOnly && keywordRe.test((e.iconLabel ?? "").toLowerCase())) {
      return e;
    }
    // 3. Visible text / accessible label naming the provider + an
    //    auth verb. The auth verb requirement rejects nav and policy
    //    links that merely mention the provider.
    const text = normalizeOAuthButtonText(
      `${visibleText} ${e.ariaLabel ?? ""} ${e.labelText ?? ""}`,
      keyword,
    )
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
    if (!keywordRe.test(text)) continue;
    // "with <provider>" is the OAuth-button idiom and is accepted
    // directly — it survives an SVG accessible name glued to the verb.
    // elevenlabs renders its button text as "GoogleSign up with Google",
    // which fuses "sign" into "googlesign" so the bare \bsign\b check
    // misses, but "with google" still matches. (A blanket camelCase split
    // can't be used to un-glue it — it would mangle the provider name
    // itself, e.g. "GitHub" → "Git Hub".)
    const withProviderRe = new RegExp(`\\bwith ${keyword}\\b`);
    if (
      /\b(sign|signup|signin|continue|log ?in|connect|auth)\b/.test(text) ||
      withProviderRe.test(text)
    ) {
      return e;
    }
    // rc.39 — minimal-label OAuth buttons. Some auth UIs render the
    // provider as a bare keyword button: just "GitHub" or just "Google"
    // (Turso, several Stytch / Clerk / Auth0 templates). When the
    // VISIBLE text is essentially nothing but the provider keyword,
    // accept it — no auth-verb required. The keyword regex already
    // ensured the provider name is present; the length cap MAX_OAUTH_
    // BUTTON_TEXT_CHARS (60) ensures it's still buttonish, not a
    // paragraph that happens to mention the provider.
    //
    // 0.8.3-rc.1 — reject minimal-label matches whose href points at
    // a NON-AUTH path on the provider's domain (most often a project
    // repo URL like github.com/plausible/analytics in a homepage
    // footer). Without this gate, plausible's footer "GitHub" link
    // matched, the bot clicked it, ended up on the analytics repo's
    // page, and misclassified the README content as a security
    // challenge — burning the entire OAuth budget on a false alarm.
    const stripped = visibleText.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (stripped === keyword || stripped === `with ${keyword}`) {
      // When the element is an <a> with a provider-domain href, require
      // it to look like an auth route. Repo / docs / marketing links
      // on the provider's site never start an OAuth flow.
      if (href.length > 0) {
        const providerDomain =
          provider === "github" ? "github.com" : "google.com";
        if (href.includes(providerDomain)) {
          // Accept only if href matches the auth pattern OR points
          // at a login/signup/sessions/oauth path.
          const looksLikeAuthPath =
            hrefRe.test(href) ||
            /github\.com\/(?:login|signin|sign-in|sessions|oauth\/authorize|apps\/[^/]+\/installations\/new|users\/sign_in)/i.test(
              href,
            ) ||
            /accounts\.google\.com\/(?:o\/oauth2|signin)/i.test(href);
          if (!looksLikeAuthPath) continue;
        }
      }
      return e;
    }
  }
  return null;
}
