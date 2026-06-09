// Unique-org-name recovery selectors — the kinde frontier: the operator's
// prior account took "tsagent", so the pre-filled business name collides, the
// auto-derived subdomain goes aria-invalid, and Next re-presents the step. The
// recovery overwrites the NAME field (which re-derives the subdomain) with a
// unique value and resubmits. Field shapes below are kinde's real ones.

import { describe, expect, it } from "vitest";
import { pickUniqueNameField, pickOnboardingSubmit } from "../agent.js";
import type { InteractiveElement } from "../browser.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "input",
    type: "text",
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "input",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("pickUniqueNameField", () => {
  it("prefers the business-name field over the derived domain (kinde)", () => {
    const inv = [
      el({ name: "p_business_name", id: "input_field_p_business_name_business_name", selector: "#bn" }),
      el({ name: "p_domain_name", id: "input_field_p_domain_name_kinde_domain", selector: "#dn" }),
    ];
    expect(pickUniqueNameField(inv)?.selector).toBe("#bn");
  });

  it("matches org / workspace / team / company name fields", () => {
    for (const n of ["organization_name", "workspace-name", "team name", "companyName"]) {
      expect(pickUniqueNameField([el({ name: n, selector: "#x" })])?.selector).toBe("#x");
    }
  });

  it("falls back to a subdomain/slug field when there's no name field", () => {
    expect(
      pickUniqueNameField([el({ name: "subdomain", selector: "#sd" })])?.selector,
    ).toBe("#sd");
  });

  it("returns null when no name/domain field is present (genuine click-stall)", () => {
    expect(pickUniqueNameField([el({ tag: "button", name: "submit" })])).toBeNull();
    expect(pickUniqueNameField([el({ name: "email", type: "email" })])).toBeNull();
  });
});

describe("pickOnboardingSubmit", () => {
  it("picks an advance-verb button", () => {
    const inv = [
      el({ tag: "button", visibleText: "Cancel", selector: "#c" }),
      el({ tag: "button", visibleText: "Next", selector: "#n" }),
    ];
    expect(pickOnboardingSubmit(inv)?.selector).toBe("#n");
  });

  it("picks a type=submit button when there's no verb text (kinde's bare submit)", () => {
    const inv = [el({ tag: "button", type: "submit", visibleText: null, selector: "#s" })];
    expect(pickOnboardingSubmit(inv)?.selector).toBe("#s");
  });

  it("returns null when there are no buttons", () => {
    expect(pickOnboardingSubmit([el({ tag: "input", name: "x" })])).toBeNull();
  });
});
