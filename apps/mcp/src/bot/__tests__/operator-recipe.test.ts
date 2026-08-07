import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OperatorRecipeSchema,
  writeRecipe,
  readRecipe,
  listRecipes,
  renderOperatorRecipeHint,
  checkSuccessSignal,
  fillTemplate,
  recipeEntryUrl,
  isSingleUseUrl,
  operatorRecipeDir,
  operatorRecipeDomain,
  operatorRecipeKey,
  readRecipeForTask,
  resolveRecipeFieldTarget,
  resolveRecipeTarget,
  tagProvenanceValue,
  tagTraceProvenance,
  bindKnownEmailTemplate,
  bindRecipePostcondition,
  bindRecipeTarget,
  bindRecipeValue,
  cssEscapeRecipeValue,
  localeStableFieldRole,
  verifyFilledFieldValues,
  type OperatorRecipe,
} from "../operator-recipe.js";

const RECIPE: OperatorRecipe = {
  name: "add-google-oauth",
  schema_version: 1,
  goal: "Create a Google OAuth web client and prove it issues a token",
  allowed_hosts: ["console.cloud.google.com", "developers.google.com"],
  trace: [
    {
      action: {
        kind: "goto",
        url_template: "https://console.cloud.google.com/auth/clients/create?project=${PROJECT}",
      },
    },
    { action: { kind: "click", text_match: "Web application" } },
    { action: { kind: "extract", slot: "oauth_secret" } },
    { action: { kind: "allow_host", host: "developers.google.com" } },
    { action: { kind: "type_secret", slot: "oauth_secret", text_match: "OAuth Client secret" } },
  ],
  secrets: [{ slot: "oauth_secret", sealed_from: "GCP client secret", stored: false }],
  postcondition: {
    kind: "execute_capability",
    describe: "Playground issues an access token after consent",
    success_signal: { field_text: "Access token", min_value_len: 40 },
  },
};

describe("operator-recipe IO round-trip", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "op-recipe-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
  });
  afterAll(async () => {
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes then reads back an identical recipe", async () => {
    const file = await writeRecipe(RECIPE);
    expect(file).toContain("add-google-oauth.json");
    expect(await readRecipe("add-google-oauth")).toEqual(RECIPE);
  });

  it("lists saved recipes by name", async () => {
    await writeRecipe(RECIPE);
    expect(await listRecipes()).toContain("add-google-oauth");
  });

  it("honors the env-overridden recipe dir", () => {
    expect(operatorRecipeDir()).toBe(dir);
  });

  it("stores and reads new recipes by (verb, eTLD+1)", async () => {
    const keyed: OperatorRecipe = {
      ...RECIPE,
      name: "buy-coffee",
      verb: "purchase",
      domain: "example.co.uk",
      entry_url: "https://checkout.shop.example.co.uk/cart?session=discarded",
    };
    const file = await writeRecipe(keyed);
    expect(path.basename(file)).toBe("purchase--example.co.uk.json");
    expect(
      await readRecipeForTask("purchase", "https://www.example.co.uk/another/path?q=1"),
    ).toEqual(keyed);
  });
});

describe("prepared-statement recipe key", () => {
  it("uses PSL eTLD+1 and drops subdomain, path, and query", () => {
    expect(operatorRecipeDomain("https://checkout.shop.example.co.uk/a?x=1")).toBe("example.co.uk");
    expect(operatorRecipeKey("purchase", "https://www.example.com/p/42?q=beans")).toBe(
      "purchase--example.com",
    );
  });

  it("keeps tenant subdomains on allowlisted hosts", () => {
    expect(operatorRecipeDomain("https://acme.myshopify.com/products/coffee")).toBe(
      "acme.myshopify.com",
    );
    expect(operatorRecipeDomain("https://team.notion.site/project?q=1")).toBe("team.notion.site");
    expect(operatorRecipeDomain("https://team.github.io/project?q=1")).toBe("github.io");
  });
});

describe("ordered target fallback", () => {
  const elements = [
    {
      testId: "primary",
      id: "old-id",
      name: "submit",
      role: "button",
      ariaLabel: "Buy now",
      visibleText: "Continue",
      href: "/checkout",
      selector: "#primary",
      value: null,
    },
    {
      testId: "secondary",
      id: "target-id",
      name: "other",
      role: "button",
      ariaLabel: "Buy now",
      visibleText: "Continue",
      href: "/other",
      selector: "#secondary",
      value: null,
    },
  ];

  it("takes the first successful tier, not a weighted score", () => {
    const result = resolveRecipeTarget(elements, {
      dom_hint: { testid: "primary", id: "target-id" },
      role_hint: "button",
      accessible_name: "Buy now",
    });
    expect(result?.via).toBe("testid");
    expect(result?.element.selector).toBe("#primary");
  });

  it("falls through testid to id/name, role+name, href, then css", () => {
    expect(
      resolveRecipeTarget(elements, { dom_hint: { testid: "gone", id: "target-id" } })?.via,
    ).toBe("id");
    expect(
      resolveRecipeTarget([elements[1]!], {
        dom_hint: { testid: "gone", id: "gone" },
        role_hint: "button",
        accessible_name: "Buy now",
      })?.via,
    ).toBe("role+accessible-name");
    expect(resolveRecipeTarget(elements, { href_hint: "/other" })?.via).toBe("href");
    expect(resolveRecipeTarget(elements, { css: "#secondary" })?.via).toBe("css");
  });

  it("uses visible text last and only when exactly one element matches", () => {
    expect(resolveRecipeTarget(elements, { visible_text: "Continue" })).toBeNull();
    expect(
      resolveRecipeTarget([{ ...elements[0]!, visibleText: "Unique" }], {
        visible_text: "Unique",
      })?.via,
    ).toBe("visible-text");
  });

  it("uses the synthesizer-compatible near-text hint to disambiguate a tier", () => {
    const inventory = [
      { selector: "#billing-label", visibleText: "Billing", role: null },
      {
        selector: "#billing",
        visibleText: "Continue",
        role: "button",
        ariaLabel: "Continue",
      },
      { selector: "#shipping-label", visibleText: "Shipping", role: null },
      {
        selector: "#shipping",
        visibleText: "Continue",
        role: "button",
        ariaLabel: "Continue",
      },
    ];
    const result = resolveRecipeTarget(inventory, {
      role_hint: "button",
      accessible_name: "Continue",
      near_text_hint: "Shipping",
    });
    expect(result?.element.selector).toBe("#shipping");
  });

  it("requires a unique stable-attribute match before accepting a tier", () => {
    const duplicateTestIds = [
      { ...elements[0]!, id: "duplicate", selector: "#duplicate" },
      { ...elements[0]!, id: "target-id", selector: "#target" },
    ];
    expect(
      resolveRecipeTarget(duplicateTestIds, {
        dom_hint: { testid: "primary", id: "target-id" },
      }),
    ).toMatchObject({ via: "id", element: { selector: "#target" } });
    expect(resolveRecipeTarget(duplicateTestIds, { dom_hint: { testid: "primary" } })).toBeNull();
  });

  it("requires owner context before a money field falls back to name", () => {
    const billing = {
      ...elements[0]!,
      testId: "billing-city",
      name: "city",
      ariaLabel: "City",
      selector: "#billing-city",
      autocomplete: "address-level2",
    };
    expect(
      resolveRecipeFieldTarget([billing], {
        dom_hint: { testid: "shipping-city", name: "city" },
        accessible_name: "City",
        field_role: "ac:address-level2",
      }),
    ).toBeNull();
    expect(
      resolveRecipeFieldTarget([billing], {
        dom_hint: { name: "city" },
        accessible_name: "City",
        field_role: "ac:address-level2",
      }),
    ).toBeNull();
    expect(
      resolveRecipeFieldTarget([{ ...billing, name: null }], {
        dom_hint: { testid: "shipping-city" },
        role_hint: "textbox",
        accessible_name: "City",
        field_role: "ac:address-level2",
      }),
    ).toBeNull();
    expect(
      resolveRecipeFieldTarget(
        [{ selector: "#shipping-label", visibleText: "Shipping", role: null }, billing],
        {
          dom_hint: { name: "city" },
          accessible_name: "City",
          near_text_hint: "Shipping",
          field_role: "ac:address-level2",
        },
      ),
    ).toBeNull();
    expect(
      resolveRecipeTarget([billing], {
        dom_hint: { name: "city" },
        accessible_name: "City",
      })?.element.selector,
    ).toBe("#billing-city");
  });
});

describe("locale-stable field role (money-path fill guard)", () => {
  it("derives role from autocomplete, then data-role, then distinguishing type", () => {
    expect(localeStableFieldRole({ autocomplete: "shipping given-name" })).toBe("ac:given-name");
    expect(localeStableFieldRole({ autocomplete: "family-name" })).toBe("ac:family-name");
    expect(localeStableFieldRole({ autocomplete: "on", type: "email" })).toBe("type:email");
    expect(localeStableFieldRole({ autocomplete: null, type: "text", dataRole: "ship-city" })).toBe(
      "data:ship-city",
    );
    expect(localeStableFieldRole({ autocomplete: null, type: "text" })).toBeNull();
  });

  it("skips the webauthn modifier token so annotated fields keep distinct roles", () => {
    expect(localeStableFieldRole({ autocomplete: "username webauthn" })).toBe("ac:username");
    expect(localeStableFieldRole({ autocomplete: "one-time-code webauthn" })).toBe(
      "ac:one-time-code",
    );
  });

  it("never wrong-fills when first/last labels swap under stable ids (report mutation #4)", () => {
    // Verbatim from shape-partial-match-safety report: ids/names unchanged,
    // only labels swapped. Without a matching field_role the fill is a miss.
    const firstNameBox = {
      testId: null,
      id: "TextFieldP0-53",
      name: "firstName",
      labelText: "Last name", // swapped
      selector: "#TextFieldP0-53",
      value: "",
      type: "text",
      autocomplete: null as string | null,
    };
    const lastNameBox = {
      testId: null,
      id: "TextFieldP0-54",
      name: "lastName",
      labelText: "First name", // swapped
      selector: "#TextFieldP0-54",
      value: "",
      type: "text",
      autocomplete: null as string | null,
    };
    const elements = [firstNameBox, lastNameBox];
    // Recipe recorded without field_role (no stable signal at capture) → miss.
    expect(
      resolveRecipeFieldTarget(elements, {
        dom_hint: { id: "TextFieldP0-53" },
        accessible_name: "First name",
      }),
    ).toBeNull();
    // Even with a recorded role, live has no role signal → miss (safe by default).
    expect(
      resolveRecipeFieldTarget(elements, {
        dom_hint: { id: "TextFieldP0-53" },
        accessible_name: "First name",
        field_role: "ac:given-name",
      }),
    ).toBeNull();
    // Guard reports missing, never clean on a value that landed in the wrong box.
    expect(
      verifyFilledFieldValues(elements, [
        {
          target: {
            dom_hint: { id: "TextFieldP0-53" },
            accessible_name: "First name",
            field_role: "ac:given-name",
          },
          expected: "Jordan",
          hole: "address.first_name",
        },
      ]),
    ).toEqual({ ok: false, reason: "field_missing", field: "address.first_name" });
  });

  it("misses when id still resolves but autocomplete role drifted", () => {
    const element = {
      id: "TextFieldP0-53",
      name: "firstName",
      labelText: "First name",
      selector: "#TextFieldP0-53",
      value: "",
      type: "text",
      autocomplete: "family-name", // role no longer matches the recorded hole
    };
    expect(
      resolveRecipeFieldTarget([element], {
        dom_hint: { id: "TextFieldP0-53" },
        accessible_name: "First name",
        field_role: "ac:given-name",
      }),
    ).toBeNull();
  });

  it("fills when role token matches even if visible label differs (EN→JP cross-locale)", () => {
    // Proven behavior: EN-recorded plan replays on a Japanese page with
    // reversed field order — identity is the autocomplete token, not the label.
    const jpGivenName = {
      id: "TextFieldP0-54", // order reversed vs EN recording
      name: "firstName",
      labelText: "名", // Japanese "given name"
      selector: "#TextFieldP0-54",
      value: "",
      type: "text",
      autocomplete: "given-name",
    };
    const jpFamilyName = {
      id: "TextFieldP0-53",
      name: "lastName",
      labelText: "姓",
      selector: "#TextFieldP0-53",
      value: "Jordan",
      type: "text",
      autocomplete: "family-name",
    };
    const resolution = resolveRecipeFieldTarget([jpFamilyName, jpGivenName], {
      dom_hint: { id: "TextFieldP0-54" },
      accessible_name: "First name", // EN label from recording — must not be required
      field_role: "ac:given-name",
    });
    expect(resolution?.element.selector).toBe("#TextFieldP0-54");
    expect(
      verifyFilledFieldValues(
        [{ ...jpGivenName, value: "Jordan" }, jpFamilyName],
        [
          {
            target: {
              dom_hint: { id: "TextFieldP0-54" },
              accessible_name: "First name",
              field_role: "ac:given-name",
            },
            expected: "Jordan",
            hole: "address.first_name",
          },
        ],
      ),
    ).toEqual({ ok: true });
  });

  it("happy path unchanged when role tokens match", () => {
    const element = {
      testId: "shipping-city",
      id: "city",
      name: "city",
      labelText: "City",
      selector: "#city",
      value: "Queens",
      type: "text",
      autocomplete: "address-level2",
    };
    expect(
      resolveRecipeFieldTarget([element], {
        dom_hint: { testid: "shipping-city" },
        field_role: "ac:address-level2",
      })?.element.selector,
    ).toBe("#city");
    expect(
      verifyFilledFieldValues(
        [element],
        [
          {
            target: { dom_hint: { testid: "shipping-city" }, field_role: "ac:address-level2" },
            expected: "Queens",
            hole: "address.city",
          },
        ],
      ),
    ).toEqual({ ok: true });
  });
});

describe("provenance holes", () => {
  const inputs = {
    product_query: "dark roast",
    address: { city: "Brooklyn", postal_code: "11201" },
    contact: { email: "ada@example.com" },
    credential: "vault-secret",
    card: { last4: "4242" },
    quantity: 3,
  };

  it("tags exact known inputs and leaves unknown literals alone", () => {
    expect(tagProvenanceValue("dark roast", inputs)).toEqual({ hole: "product_query" });
    expect(tagProvenanceValue("Brooklyn", inputs)).toEqual({ hole: "address.city" });
    expect(tagProvenanceValue("3", inputs)).toEqual({ hole: "quantity" });
    expect(tagProvenanceValue("${EMAIL_ALIAS}", inputs)).toEqual({ hole: "contact.email" });
    expect(tagProvenanceValue("Create account", inputs)).toBe("Create account");
  });

  it("tags trace values without changing non-value fields and binds on replay", () => {
    const trace = tagTraceProvenance(
      [{ action: { kind: "type", value: "Brooklyn", text_match: "City" } }],
      inputs,
    );
    expect(trace[0]?.action.value).toEqual({ hole: "address.city" });
    expect(bindRecipeValue(trace[0]!.action.value!, { "address.city": "Queens" })).toBe("Queens");
  });

  it("binds known-email transforms across every serialized target hint", () => {
    const target = bindRecipeTarget(
      {
        dom_hint: {
          testid: "email-${EMAIL_ALIAS}",
          id: "${EMAIL_ALIAS}",
          name: "${EMAIL_ALIAS}",
        },
        role_hint: "textbox-${EMAIL_ALIAS}",
        accessible_name: "Account ${EMAIL_ALIAS}",
        near_text_hint: "Signed in as ${EMAIL_ALIAS}",
        href_hint: "/accounts/${EMAIL_ALIAS}",
        css: '[aria-label="${EMAIL_ALIAS}"]',
        visible_text: "${EMAIL_ALIAS}",
      },
      { "address.email": "buyer@example.com" },
      "address.email",
    );
    expect(JSON.stringify(target)).not.toContain("${EMAIL_ALIAS}");
    expect(JSON.stringify(target)).toContain("buyer@example.com");
    expect(() => bindRecipeTarget({ visible_text: "${EMAIL_ALIAS}" }, {}, "address.email")).toThrow(
      /missing recipe binding: address\.email/i,
    );
    expect(() =>
      bindRecipeTarget({ visible_text: "${EMAIL_ALIAS}" }, { "contact.email": "x@y.test" }),
    ).toThrow(/lacks an attested source hole/i);
  });

  it("rebinds escaped and encoded known-email target transforms", () => {
    const email = "buyer@example.com";
    const target = bindRecipeTarget(
      {
        css: '[data-testid="${EMAIL_ALIAS_CSS}"]',
        href_hint: "/account/${EMAIL_ALIAS_URI}",
        visible_text: "${EMAIL_ALIAS}",
      },
      { "contact.email": email },
      "contact.email",
    );
    expect(target.css).toBe(`[data-testid="${cssEscapeRecipeValue(email)}"]`);
    expect(target.href_hint).toBe(`/account/${encodeURIComponent(email)}`);
    expect(target.visible_text).toBe(email);
  });

  it("binds credential-backed known-email URL transforms", () => {
    expect(
      bindKnownEmailTemplate(
        "https://service.test/account/${EMAIL_ALIAS_URI}",
        { "credential.login": "buyer@example.com" },
        "credential.login",
      ),
    ).toBe("https://service.test/account/buyer%40example.com");
    expect(
      bindKnownEmailTemplate(
        "https://service.test/account/${EMAIL_ALIAS_URI_URI}",
        { "credential.login": "buyer@example.com" },
        "credential.login",
      ),
    ).toBe("https://service.test/account/buyer%2540example.com");
    expect(
      bindRecipePostcondition(
        {
          kind: "observe_artifact",
          describe: "Account artifact exists",
          probe_url: "https://service.test/account/${EMAIL_ALIAS_URI_URI}",
          success_signal: { url_contains: "/account/${EMAIL_ALIAS_URI_URI}" },
          email_hole: "credential.login",
        },
        { "credential.login": "buyer@example.com" },
      ),
    ).toMatchObject({
      probe_url: "https://service.test/account/buyer%2540example.com",
      success_signal: { url_contains: "/account/buyer%2540example.com" },
    });
    expect(() =>
      OperatorRecipeSchema.parse({
        ...RECIPE,
        postcondition: {
          kind: "observe_artifact",
          describe: "Account artifact exists",
          probe_url: "https://service.test/account/${EMAIL_ALIAS_URI}",
          success_signal: { url_contains: "/account/${EMAIL_ALIAS_URI}" },
        },
      }),
    ).toThrow(/attested source hole/);
    expect(
      OperatorRecipeSchema.parse({
        ...RECIPE,
        trace: [
          {
            action: {
              kind: "goto",
              url_template: "https://service.test/account/${EMAIL_ALIAS_URI}",
              email_hole: "credential.login",
            },
          },
        ],
      }).trace[0]?.action.email_hole,
    ).toBe("credential.login");
  });

  it("rejects ambiguous exact-value provenance instead of choosing the first hole", () => {
    expect(() =>
      tagProvenanceValue("ada@example.com", {
        address: { email: "ada@example.com" },
        contact: { email: "ada@example.com" },
      }),
    ).toThrow(/ambiguous recipe provenance.*address\.email, contact\.email/i);
  });

  it("tags select and phone-country values while preserving credential and card holes", () => {
    const trace = tagTraceProvenance(
      [
        { action: { kind: "select", value: "3", text_match: "Quantity" } },
        { action: { kind: "set_phone_country", value: "Brooklyn" } },
        {
          action: {
            kind: "type_secret",
            slot: "oauth_secret",
            value: { hole: "credential.oauth_secret" },
            text_match: "Secret",
          },
        },
        { action: { kind: "operate_pay", value: { hole: "card" } } },
      ],
      inputs,
    );
    expect(trace.map((entry) => entry.action.value)).toEqual([
      { hole: "quantity" },
      { hole: "address.city" },
      { hole: "credential.oauth_secret" },
      { hole: "card" },
    ]);
  });

  it("keeps card and credential holes on their sealed injection actions", () => {
    expect(
      OperatorRecipeSchema.safeParse({
        ...RECIPE,
        trace: [
          {
            action: {
              kind: "type",
              value: { hole: "card.pan" },
              text_match: "Card number",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      OperatorRecipeSchema.safeParse({
        ...RECIPE,
        trace: [{ action: { kind: "operate_pay", value: { hole: "card" } } }],
      }).success,
    ).toBe(true);
  });
});

describe("money-path field-value guard", () => {
  const target = {
    dom_hint: { testid: "shipping-city" },
    visible_text: "City",
    field_role: "ac:address-level2",
  };
  const element = {
    testId: "shipping-city",
    selector: "#city",
    value: "Queens",
    visibleText: null,
    autocomplete: "address-level2",
  };

  it("passes only on exact injected values", () => {
    expect(
      verifyFilledFieldValues([element], [{ target, expected: "Queens", hole: "address.city" }]),
    ).toEqual({ ok: true });
  });

  it("verifies selects by their committed option label", () => {
    const countryTarget = {
      dom_hint: { testid: "shipping-city" },
      field_role: "ac:country",
    };
    const countryEl = { ...element, autocomplete: "country" };
    expect(
      verifyFilledFieldValues(
        [{ ...countryEl, value: "US", selectedOptionText: "United States" }],
        [
          {
            target: countryTarget,
            expected: "United States",
            hole: "address.country",
            kind: "select",
          },
        ],
      ),
    ).toEqual({ ok: true });
    expect(
      verifyFilledFieldValues(
        [{ ...countryEl, value: null, visibleText: "United States" }],
        [
          {
            target: countryTarget,
            expected: "United States",
            hole: "address.country",
            kind: "select",
          },
        ],
      ),
    ).toEqual({ ok: true });
  });

  it("aborts on mismatch or a missing field", () => {
    expect(
      verifyFilledFieldValues([element], [{ target, expected: "Brooklyn", hole: "address.city" }]),
    ).toEqual({ ok: false, reason: "field_value_mismatch", field: "address.city" });
    expect(
      verifyFilledFieldValues([], [{ target, expected: "Queens", hole: "address.city" }]),
    ).toEqual({ ok: false, reason: "field_missing", field: "address.city" });
  });
});

describe("iron invariant: a recipe never stores a secret VALUE", () => {
  it("schema rejects a secret marked stored:true", () => {
    const bad = { ...RECIPE, secrets: [{ slot: "oauth_secret", stored: true }] };
    expect(OperatorRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("schema rejects a value-bearing field on a secret (strict)", () => {
    const bad = {
      ...RECIPE,
      secrets: [{ slot: "oauth_secret", stored: false, value: "GOCSPX-leak" }],
    };
    expect(OperatorRecipeSchema.safeParse(bad).success).toBe(false);
  });

  it("a written recipe with a sealed secret carries no value on disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "op-recipe-iron-"));
    process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = dir;
    const file = await writeRecipe(RECIPE);
    const raw = await fs.readFile(file, "utf8");
    expect(raw).toContain("oauth_secret"); // the slot ref is present
    expect(raw).toContain('"stored": false'); // marked unstored
    expect(raw).not.toMatch(/GOCSPX-/); // no Google client-secret value anywhere
    delete process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR;
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("renderOperatorRecipeHint (a MAP, not a script)", () => {
  const hint = renderOperatorRecipeHint(RECIPE);

  it("frames the recipe as a map with a fallback", () => {
    expect(hint).toContain("a MAP, not a script");
    expect(hint).toContain("fall back to your own judgment");
  });

  it("includes the goal and a numbered route from the trace", () => {
    expect(hint).toContain("goal: Create a Google OAuth");
    expect(hint).toMatch(/1\. go to https:\/\/console\.cloud\.google\.com/);
    expect(hint).toContain('click "Web application"');
  });

  it("tells the host to re-seal secrets, not read them from the recipe", () => {
    expect(hint).toContain("reveal + seal");
  });

  it("states the machine-checkable success condition", () => {
    expect(hint).toContain("success when: Playground issues an access token");
  });
});

describe("checkSuccessSignal (the anti-false-green gate)", () => {
  const tokenSnap = {
    url: "https://developers.google.com/oauthplayground/",
    text: "",
    fields: [{ label: "Access token:", value_len: 253 }],
  };

  it("field_text confirms only when a matching field is long enough", () => {
    expect(
      checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, tokenSnap).confirmed,
    ).toBe(true);
  });

  it("field_text fails when the value is too short", () => {
    const snap = { ...tokenSnap, fields: [{ label: "Access token:", value_len: 10 }] };
    const r = checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, snap);
    expect(r.confirmed).toBe(false);
    expect(r.reason).toContain("too short");
  });

  it("field_text fails when no field matches", () => {
    const snap = { ...tokenSnap, fields: [{ label: "Email", value_len: 99 }] };
    expect(
      checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, snap).confirmed,
    ).toBe(false);
  });

  it("evidence carries the LENGTH, never the value", () => {
    const r = checkSuccessSignal({ field_text: "Access token", min_value_len: 40 }, tokenSnap);
    expect(r.evidence).toEqual({ field: "Access token", value_len: 253, required: 40 });
  });

  it("text_present and url_contains both work", () => {
    const snap = {
      url: "https://app.example.com/dashboard",
      text: "Welcome back, you are signed in",
      fields: [],
    };
    expect(checkSuccessSignal({ text_present: "Welcome back" }, snap).confirmed).toBe(true);
    expect(checkSuccessSignal({ url_contains: "/dashboard" }, snap).confirmed).toBe(true);
    expect(checkSuccessSignal({ url_contains: "/login" }, snap).confirmed).toBe(false);
  });
});

describe("fillTemplate + recipeEntryUrl", () => {
  it("fills ${VAR} and reports any missing params", () => {
    expect(fillTemplate("a/${PROJECT}/b", { PROJECT: "x" })).toEqual({ url: "a/x/b", missing: [] });
    expect(fillTemplate("a/${PROJECT}", {}).missing).toEqual(["PROJECT"]);
  });

  it("recipeEntryUrl returns the first goto's url", () => {
    expect(recipeEntryUrl(RECIPE)).toContain("clients/create");
  });

  it("recipeEntryUrl is null when no goto exists", () => {
    expect(
      recipeEntryUrl({ ...RECIPE, trace: [{ action: { kind: "click", text_match: "x" } }] }),
    ).toBeNull();
  });
});

// Regression for the plunk-recipe replay bug (2026-06-30): a single-use
// email-verify token URL was frozen into the trace as a goto AND became the
// replay entry, so operate_use opened on an expired-token "Verification failed"
// page every time.
describe("single-use link handling (replay-entry safety)", () => {
  it("isSingleUseUrl flags verify/magic/reset links carrying an opaque token", () => {
    expect(
      isSingleUseUrl(
        "https://next-app.useplunk.com/auth/verify-email?token=52b0afc93ef2e162f0abfa96b209c7abda1abc53ef63cf9923222f7df9395ef4",
      ),
    ).toBe(true);
    expect(isSingleUseUrl("https://app.example.com/magic?code=ab12cd34ef56gh78ij90")).toBe(true);
    expect(isSingleUseUrl("/magic?code=ab12cd34ef56gh78ij90")).toBe(true);
    expect(isSingleUseUrl("https://example.com/password-reset/Xy7Kp2Qm9Tw4Rs6Lf0Bn3")).toBe(true);
    expect(isSingleUseUrl("https://id.example.com/confirm?oobCode=AB12cd34EF56gh78IJ90kl")).toBe(
      true,
    );
  });

  it("isSingleUseUrl does NOT flag stable app URLs", () => {
    expect(isSingleUseUrl("https://openrouter.ai/settings/keys")).toBe(false);
    expect(isSingleUseUrl("https://vouchflow.dev/settings/apps/app_083e0004")).toBe(false);
    expect(isSingleUseUrl("https://app.posthog.com/project/123/settings")).toBe(false);
    // verify-ish path but NO opaque token → a real settings page, keep it
    expect(isSingleUseUrl("https://example.com/account/confirm-email-change")).toBe(false);
    // short/non-token query value → not single-use
    expect(isSingleUseUrl("https://example.com/verify?token=123")).toBe(false);
    expect(isSingleUseUrl("not a url")).toBe(false);
  });

  it("recipeEntryUrl prefers entry_url over trace gotos", () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      entry_url: "https://service.example.com/signup",
      trace: [{ action: { kind: "goto", url_template: "https://service.example.com/dashboard" } }],
    };
    expect(recipeEntryUrl(r)).toBe("https://service.example.com/signup");
  });

  it("recipeEntryUrl fallback skips a single-use goto and picks the next stable one", () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      entry_url: undefined,
      trace: [
        {
          action: {
            kind: "goto",
            url_template: "https://svc.example.com/verify-email?token=ab12cd34ef56gh78ij90kl",
          },
        },
        { action: { kind: "goto", url_template: "https://svc.example.com/login" } },
      ],
    };
    expect(recipeEntryUrl(r)).toBe("https://svc.example.com/login");
  });

  it("recipeEntryUrl ignores a persisted single-use entry", () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      entry_url: "https://svc.example.com/magic?code=ab12cd34ef56gh78ij90kl",
      trace: [{ action: { kind: "goto", url_template: "https://svc.example.com/login" } }],
    };
    expect(recipeEntryUrl(r)).toBe("https://svc.example.com/login");
  });

  it("recipeEntryUrl resolves runtime entries from the current service URL", () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      verb: "purchase",
      domain: "example.com",
      entry_url: undefined,
      entry_mode: "runtime_service_url",
    };
    expect(recipeEntryUrl(r)).toBeNull();
    expect(recipeEntryUrl(r, "https://svc.example.com/signup")).toBe(
      "https://svc.example.com/signup",
    );
    expect(() => recipeEntryUrl(r, "https://attacker.test/signup")).toThrow(
      /domain does not match/i,
    );
  });

  it("recipeEntryUrl is null when the only goto is single-use (no dead-page entry)", () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      entry_url: undefined,
      trace: [
        {
          action: {
            kind: "goto",
            url_template: "https://svc.example.com/verify-email?token=ab12cd34ef56gh78ij90kl",
          },
        },
      ],
    };
    expect(recipeEntryUrl(r)).toBeNull();
  });

  it("entry_url round-trips through the schema (write/read)", async () => {
    const r: OperatorRecipe = {
      ...RECIPE,
      name: "entry-url-roundtrip",
      entry_url: "https://svc.example.com/start",
    };
    await writeRecipe(r);
    expect((await readRecipe("entry-url-roundtrip")).entry_url).toBe(
      "https://svc.example.com/start",
    );
  });
});
