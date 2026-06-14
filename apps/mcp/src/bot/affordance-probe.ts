// affordance-probe.ts — the ONE canonical "load a page, read its
// affordances" primitive. The GROUND TRUTH for "what does this page
// actually offer": OAuth providers, an email-signup form, a card gate,
// an anti-bot interstitial.
//
// Why this module exists: the same "BrowserController.start → goto →
// extract → classify" routine was duplicated across two CLI probes
// (tools/affordance-probe.mjs, tools/egress-doorcheck.mjs). Both now
// call THIS. And the verify loop uses it to distinguish a brittle
// replay failure (page still servable) from genuine skill rot.
//
// The classification is split into a PURE function (classifyAffordances)
// that takes an already-extracted inventory + text — unit-testable
// without a browser — and an async probeAffordances that does the DOM
// read and delegates to the pure classifier.

import type { BrowserController, InteractiveElement } from "./browser.js";
import { classifyInterstitialText } from "./browser.js";
import { findOAuthButton } from "./agent.js";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth-providers.js";

const PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS) as OAuthProviderId[];

export interface PageAffordances {
  providers: OAuthProviderId[];
  has_email_signup: boolean;
  has_email_field: boolean;
  card_gate: boolean;
  interstitial: boolean;
  final_url: string;
  inventory_size: number;
}

// The classification-only slice — everything PageAffordances reports
// EXCEPT the two fields that require a live browser (final URL after
// redirects, inventory count).
export type AffordanceClassification = Omit<
  PageAffordances,
  "final_url" | "inventory_size"
>;

// Pure: classify a page's interactive inventory + visible text into
// affordances. No browser, no I/O — given the same inputs it always
// returns the same result, which is what makes it unit-testable.
export function classifyAffordances(
  inventory: readonly InteractiveElement[],
  text: string,
): AffordanceClassification {
  const providers = PROVIDER_IDS.filter(
    (p) => findOAuthButton(inventory, p) !== null,
  );
  const isField = (el: InteractiveElement, ...types: string[]): boolean =>
    el.tag === "input" &&
    (types.includes(el.type ?? "") ||
      types.some((t) => (el.name ?? "").toLowerCase().includes(t)));
  const has_email = inventory.some(
    (el) => isField(el, "email") || /email/i.test(el.name ?? el.placeholder ?? ""),
  );
  const has_password = inventory.some((el) => isField(el, "password"));
  const card_field = inventory.some(
    (el) =>
      el.tag === "input" &&
      /card|cc-?number|cardnumber|cvc|cvv/i.test(
        `${el.name ?? ""} ${el.placeholder ?? ""} ${el.ariaLabel ?? ""}`,
      ),
  );
  const card_text =
    /\b(credit card|payment method|card number|billing (information|details))\b/i.test(
      text,
    );
  const { onInterstitial, verificationPassed } = classifyInterstitialText(text);
  return {
    providers,
    has_email_signup: has_email && has_password,
    has_email_field: has_email,
    card_gate: card_field || card_text,
    interstitial: onInterstitial && !verificationPassed,
  };
}

// Load `url` in the given (already-started) browser and report its
// affordances. The caller owns the BrowserController lifecycle — this
// only navigates + reads, so it can be reused mid-flow (e.g. the
// verifier's auto-probe-before-retire guard borrows the browser it
// already has open).
export async function probeAffordances(
  browser: BrowserController,
  url: string,
): Promise<PageAffordances> {
  await browser.goto(url);
  await browser.wait(3);
  const [inventory, text] = await Promise.all([
    browser.extractInteractiveElements(),
    browser
      .extractText()
      .then((s) => s.slice(0, 6000))
      .catch(() => ""),
  ]);
  return {
    ...classifyAffordances(inventory, text),
    final_url: browser.currentUrl(),
    inventory_size: inventory.length,
  };
}
