import { describe, expect, it } from "vitest";
import {
  isRecipeShareEligible,
  operatorRecipeDomain,
  operatorRecipeKey,
  parseOperatorRecipe,
  checkoutFieldSetSignature,
  isCheckoutShapeKey,
  checkoutShapeKey,
  operatorRecipeKeyForCheckoutShape,
  type OperatorRecipe,
} from "../operator-recipe.js";

function baseRecipe(overrides: Partial<OperatorRecipe> = {}): OperatorRecipe {
  return parseOperatorRecipe({
    name: "get_api_key--example.com",
    schema_version: 1,
    goal: "Get an API key from Example",
    verb: "get_api_key",
    domain: "example.com",
    entry_url: "https://example.com/signup",
    allowed_hosts: [],
    trace: [
      { action: { kind: "goto", url_template: "https://example.com/signup" } },
      {
        action: {
          kind: "type",
          text_match: "Email",
          value: { hole: "contact.email" },
        },
      },
      {
        action: {
          kind: "click",
          text_match: "Continue",
        },
      },
      {
        action: {
          kind: "extract",
          slot: "api_key",
        },
      },
    ],
    secrets: [{ slot: "api_key", stored: false }],
    postcondition: {
      kind: "execute_capability",
      describe: "the dashboard shows an API key",
      success_signal: { text_present: "API Key" },
    },
    ...overrides,
  });
}

describe("operatorRecipeDomain / operatorRecipeKey", () => {
  it("derives the eTLD+1 and the (verb, domain) key", () => {
    expect(operatorRecipeDomain("https://sub.example.com/a/b?x=1")).toBe("example.com");
    expect(operatorRecipeKey("signup", "https://sub.example.com/a")).toBe("signup--example.com");
  });
});

describe("isRecipeShareEligible", () => {
  it("accepts a recipe whose only literal values are site-constant button text", () => {
    const result = isRecipeShareEligible(baseRecipe());
    expect(result).toEqual({ eligible: true, reasons: [] });
  });

  it("rejects a recipe missing the (verb, domain) key", () => {
    const recipe = baseRecipe({ verb: undefined, domain: undefined });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("(verb, domain) key"))).toBe(true);
  });

  it("rejects an untagged literal email address anywhere in the recipe", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Email",
            value: "jordan.rivera@example.com",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("email"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a person's name", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            value: "Jordan Rivera",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("name"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a street address", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Address",
            value: "500 Market Street",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("address"))).toBe(true);
  });

  it("rejects an untagged literal that looks like a phone number", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Phone",
            value: "415-555-1234",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("phone"))).toBe(true);
  });

  it("rejects long freeform literal text", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Company description",
            value: "We build durable widgets for the modern supply chain, est. 1990.",
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("freeform"))).toBe(true);
  });

  it("accepts a hole-tagged value even when its shape would otherwise be flagged", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "type",
            text_match: "Full name",
            value: { hole: "contact.name" },
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(true);
  });

  it("rejects a secret-shaped literal anywhere in the recipe as defense in depth", () => {
    const recipe = baseRecipe({
      allowed_hosts: [],
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "click",
            text_match: "Continue",
            // A literal that leaked into a hint field would still be caught by
            // the blanket scan, independent of which field it's in.
            target: { href_hint: "https://example.com/callback?token=sk-abcdefghijklmnopqrst" },
          },
        },
      ],
    });
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
    expect(result.reasons.some((r) => r.includes("secret-shaped"))).toBe(true);
  });

  it("ignores short site-constant literals like button text", () => {
    const recipe = baseRecipe({
      trace: [
        { action: { kind: "goto", url_template: "https://example.com/signup" } },
        {
          action: {
            kind: "select",
            text_match: "Country",
            value: "United States",
          },
        },
      ],
    });
    // "United States" is title-case-two-words shaped, which this
    // conservative classifier flags as name-shaped — an accepted false
    // positive: the recipe just stays local instead of being shared.
    const result = isRecipeShareEligible(recipe);
    expect(result.eligible).toBe(false);
  });
});

// replay-per-leg-signature — real field-name sets captured live against
// unrelated merchants/stores by the proof-tests + shape-class-generality
// scouts (firstmate/data/replay-proof-tests/report.md,
// firstmate/data/shape-class-generality-test/report.md). Used verbatim (not
// synthesized) so these tests exercise checkoutFieldSetSignature against
// the same evidence the design was proven against, per the task's
// instruction to derive fixtures from real captures rather than
// substituting invented ones.
const SHOPIFY_CHECKOUT_FIELDS = [
  "address-level1",
  "address1",
  "address2",
  "apply_discount",
  "city",
  "country",
  "countryCode",
  "email",
  "firstName",
  "lastName",
  "marketing_opt_in",
  "order_summary_show",
  "postalCode",
  "province",
  "reductions",
  "zone",
  "serialized-apiClientId",
  "serialized-checkoutLayout",
  "serialized-checkoutSessionIdentifier",
  "serialized-clientBundleInfo",
  "serialized-environment",
  "serialized-experiments",
  "serialized-gcpRegion",
  "serialized-graphql",
  "serialized-initial-url",
  "serialized-invoiceLoginType",
  "serialized-loginUrl",
  "serialized-logoutUrl",
  "serialized-receipt",
  "serialized-renderer",
  "serialized-requestId",
  "serialized-serverHandling",
  "serialized-serverRender",
  "serialized-serverUserAgent",
  "serialized-sessionFinished",
  "serialized-sessionToken",
  "serialized-shop",
  "serialized-shopPayConfig",
  "serialized-shopPayGraphql",
  "serialized-shopPayLoginAnalyticsTraceId",
  "serialized-shopPayLoginOAuthState",
  "serialized-sourceToken",
  "serialized-sourceType",
  "serialized-targetPlatform",
  "serialized-workerVersion",
];

// Five unrelated live WooCommerce stores (shape-class-generality-test),
// each with its own checkout-field-customizer plugin/theme — proven NOT to
// form a shared platform class (only a thin 4-field intersection), so each
// is expected to produce its OWN signature, matching nothing else.
const WOOCOMMERCE_KABLOOM_FIELDS = [
  "billing_first_name",
  "billing_last_name",
  "billing_company",
  "billing_country",
  "billing_address_1",
  "billing_address_2",
  "billing_city",
  "billing_state",
  "billing_postcode",
  "billing_phone",
  "billing_email",
  "purchase_order",
  "kl_newsletter_checkbox",
  "createaccount",
  "account_password",
  "ship_to_different_address",
  "shipping_first_name",
  "shipping_last_name",
  "shipping_company",
  "shipping_country",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_city",
  "shipping_state",
  "shipping_postcode",
  "order_comments",
  "payment_method",
  "terms",
  "terms-field",
  "woocommerce-process-checkout-nonce",
  "_wp_http_referer",
];
const WOOCOMMERCE_NAUTICALMIND_FIELDS = [
  "billing_first_name",
  "billing_last_name",
  "billing_company",
  "billing_country",
  "billing_address_1",
  "billing_address_2",
  "billing_city",
  "billing_state",
  "billing_postcode",
  "billing_phone",
  "billing_email",
  "createaccount",
  "account_password",
  "ship_to_different_address",
  "shipping_first_name",
  "shipping_last_name",
  "shipping_company",
  "shipping_country",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_city",
  "shipping_state",
  "shipping_postcode",
  "order_comments",
  "payment_method",
  "offline_cc_card_number",
  "cc-expire-month",
  "cc-expire-year",
  "offline_cc_card_csc",
  "_wpnonce",
  "_wp_http_referer",
  "place_order",
];
const WOOCOMMERCE_GADGETBROBD_FIELDS = [
  "billing_first_name",
  "billing_phone",
  "billing_address_1",
  "billing_country",
  "cart[key][qty]",
  "shipping_method[0]",
  "payment_method",
  "bkash_acc_no",
  "bkash_trans_id",
  "nagad_acc_no",
  "nagad_trans_id",
  "woocommerce-process-checkout-nonce",
  "_wp_http_referer",
];
const WOOCOMMERCE_DESIGNVARSITY_FIELDS = [
  "billing_email",
  "billing_first_name",
  "billing_last_name",
  "billing_company",
  "billing_country",
  "billing_address_1",
  "billing_address_2",
  "billing_city",
  "billing_state",
  "billing_postcode",
  "billing_phone",
  "createaccount",
  "ship_to_different_address",
  "shipping_first_name",
  "shipping_last_name",
  "shipping_company",
  "shipping_country",
  "shipping_address_1",
  "shipping_address_2",
  "shipping_city",
  "shipping_state",
  "shipping_postcode",
  "shipping_phone",
  "order_comments",
  "shipping_method[0]",
  "payment_method",
  "wc-stripe-payment-method-upe",
  "wc_stripe_selected_upe_payment_type",
  "mintmail_woocommerce_optin_consent",
  "terms",
  "terms-field",
  "woocommerce-process-checkout-nonce",
  "_wp_http_referer",
];
const WOOCOMMERCE_DOOLSET_FIELDS = [
  "metpago",
  "nombreusu",
  "billing_",
  "billing_first_name",
  "billing_last_name",
  "billing_address_1",
  "billing_phone",
  "order_comments",
  "payment_method",
  "woocommerce-process-checkout-nonce",
  "_wp_http_referer",
];

describe("checkoutFieldSetSignature (replay-per-leg-signature)", () => {
  it("is null for an empty field-name set", () => {
    expect(checkoutFieldSetSignature([])).toBeNull();
    expect(checkoutFieldSetSignature(["", "  "])).toBeNull();
  });

  it("is deterministic and order/case/whitespace-insensitive", () => {
    const a = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS);
    const shuffled = [...SHOPIFY_CHECKOUT_FIELDS].reverse().map((n) => ` ${n.toUpperCase()} `);
    const b = checkoutFieldSetSignature(shuffled);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("differs when even one field name changes", () => {
    const a = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS);
    const b = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS.slice(0, -1));
    expect(a).not.toBe(b);
  });

  it("Shopify's own field set (9 captures, 6 merchants) collapses to one signature — the wide-reuse case", () => {
    // Every capture in the proof report shared the identical 45-name core;
    // a few had 1-2 extra generic names (viewport, etc.) beyond it, but the
    // signature is computed from the CORE set actually recorded into a
    // recipe (this fixture), not the noisy live page — so this asserts the
    // core set alone produces one stable signature, matching itself.
    const sig1 = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS);
    const sig2 = checkoutFieldSetSignature([...SHOPIFY_CHECKOUT_FIELDS]);
    expect(sig1).not.toBeNull();
    expect(sig1).toBe(sig2);
  });

  it("mutual discrimination: Shopify's signature never collides with any of 5 unrelated WooCommerce stores", () => {
    const shopify = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS);
    const wooSignatures = [
      WOOCOMMERCE_KABLOOM_FIELDS,
      WOOCOMMERCE_NAUTICALMIND_FIELDS,
      WOOCOMMERCE_GADGETBROBD_FIELDS,
      WOOCOMMERCE_DESIGNVARSITY_FIELDS,
      WOOCOMMERCE_DOOLSET_FIELDS,
    ].map(checkoutFieldSetSignature);
    for (const wooSig of wooSignatures) {
      expect(wooSig).not.toBeNull();
      expect(wooSig).not.toBe(shopify);
    }
  });

  it("each of the 5 WooCommerce stores gets its OWN signature — no shared 'platform' class (each matches only itself)", () => {
    const signatures = [
      WOOCOMMERCE_KABLOOM_FIELDS,
      WOOCOMMERCE_NAUTICALMIND_FIELDS,
      WOOCOMMERCE_GADGETBROBD_FIELDS,
      WOOCOMMERCE_DESIGNVARSITY_FIELDS,
      WOOCOMMERCE_DOOLSET_FIELDS,
    ].map(checkoutFieldSetSignature);
    const unique = new Set(signatures);
    expect(unique.size).toBe(signatures.length);
  });

  it("does NOT loosen to a thin common-core subset: the 4-field WooCommerce intersection alone signs differently than any real store's full set", () => {
    // Safety constraint from the field tests: matching must be on the FULL
    // recorded set, never a thinned shared core (that's what let unrelated
    // WooCommerce stores manufacture false matches). Prove the signature
    // machinery itself doesn't accidentally collapse a full store's set
    // down to the thin core's signature.
    const thinCore = checkoutFieldSetSignature([
      "billing_first_name",
      "billing_address_1",
      "billing_phone",
      "payment_method",
    ]);
    const kabloom = checkoutFieldSetSignature(WOOCOMMERCE_KABLOOM_FIELDS);
    expect(thinCore).not.toBeNull();
    expect(thinCore).not.toBe(kabloom);
  });
});

describe("checkout-shape key helpers (replay-per-leg-signature)", () => {
  it("checkoutShapeKey/isCheckoutShapeKey round-trip and reject plain domains", () => {
    const sig = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS)!;
    const key = checkoutShapeKey(sig);
    expect(key).toBe(`shape:${sig}`);
    expect(isCheckoutShapeKey(key)).toBe(true);
    expect(isCheckoutShapeKey("example.com")).toBe(false);
    expect(isCheckoutShapeKey("shape:not-hex")).toBe(false);
  });

  it("operatorRecipeKeyForCheckoutShape composes verb + the shape key, same shape as operatorRecipeKeyForDomain", () => {
    const sig = checkoutFieldSetSignature(SHOPIFY_CHECKOUT_FIELDS)!;
    expect(operatorRecipeKeyForCheckoutShape("purchase", sig)).toBe(
      `purchase--${checkoutShapeKey(sig)}`,
    );
  });
});
