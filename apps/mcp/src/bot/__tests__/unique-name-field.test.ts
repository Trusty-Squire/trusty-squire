// Unique-org-name recovery selectors — the kinde frontier: the operator's
// prior account took "tsagent", so the pre-filled business name collides, the
// auto-derived subdomain goes aria-invalid, and Next re-presents the step. The
// recovery overwrites the NAME field (which re-derives the subdomain) with a
// unique value and resubmits. Field shapes below are kinde's real ones.

import { describe, expect, it } from "vitest";
import {
  coerceCheckboxClickStep,
  coercePostVerifyIdentityFillStep,
  isAuthEntryPageForPreExtraction,
  isOnboardingForwardLabel,
  pickOnboardingLeafChoice,
  pickOnboardingSubmit,
  pickUniqueNameField,
  findAccountScopeListEntry,
  findPendingResourceSetupSubmit,
  findRelocatedCredentialPageRecoveryLink,
  retargetCredentialAppTypeChoice,
  retargetSubmitToDefaultedPicker,
  identityFromEmail,
} from "../agent.js";
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

describe("identityFromEmail", () => {
  it("generates punctuation-free usernames for strict signup forms", () => {
    expect(identityFromEmail("john.collins359@trustysquire.ai").username).toMatch(
      /^[a-z0-9]+$/,
    );
  });
});

describe("coercePostVerifyIdentityFillStep", () => {
  it("uses the active signup alias when the planner invents an email", () => {
    const step = coercePostVerifyIdentityFillStep(
      {
        kind: "fill",
        selector: "#email",
        value: "testuser@test.com",
        reason: "Fill in the email address",
      },
      [el({ type: "email", selector: "#email" })],
      { email: "jtaylor501@trustysquire.ai", password: "pw" },
    );
    expect(step).toMatchObject({
      kind: "fill",
      selector: "#email",
      value: "jtaylor501@trustysquire.ai",
    });
  });

  it("leaves non-identity fields alone", () => {
    const step = coercePostVerifyIdentityFillStep(
      {
        kind: "fill",
        selector: "#project",
        value: "testuser@test.com",
        reason: "Name the project",
      },
      [el({ name: "project_name", selector: "#project" })],
      { email: "jtaylor501@trustysquire.ai", password: "pw" },
    );
    expect(step).toMatchObject({ value: "testuser@test.com" });
  });
});

describe("findRelocatedCredentialPageRecoveryLink", () => {
  it("follows in-origin replacement links from migrated credential pages", () => {
    const inv = [
      el({
        tag: "a",
        visibleText: "Dashboard",
        href: "/u/alice",
        selector: "#dash",
      }),
      el({
        tag: "a",
        visibleText: "teams list",
        href: "/u/alice/api-tokens/teams",
        selector: "#teams",
      }),
    ];
    expect(
      findRelocatedCredentialPageRecoveryLink({
        currentUrl: "https://app.example.test/u/alice/api-tokens",
        pageText:
          "Page not found. User accounts have recently been migrated to teams, so this page may have existed in the past but is now a part of a team instead. Go to your teams list.",
        inventory: inv,
      })?.selector,
    ).toBe("#teams");
  });

  it("does not recover from generic non-credential 404 pages", () => {
    const inv = [
      el({
        tag: "a",
        visibleText: "Dashboard",
        href: "/dashboard",
        selector: "#dash",
      }),
    ];
    expect(
      findRelocatedCredentialPageRecoveryLink({
        currentUrl: "https://app.example.test/missing",
        pageText: "Page not found. Go to your dashboard.",
        inventory: inv,
      }),
    ).toBeNull();
  });

  it("does not follow top-level marketing team links from a dead credential route", () => {
    const inv = [
      el({
        tag: "a",
        visibleText: "Teams",
        href: "/teams",
        selector: "#teams",
      }),
      el({
        tag: "a",
        visibleText: "Pricing",
        href: "/pricing",
        selector: "#pricing",
      }),
    ];
    expect(
      findRelocatedCredentialPageRecoveryLink({
        currentUrl: "https://www.val.town/settings/api/new",
        pageText: "Page not found. Explore Teams Pricing Docs Blog",
        inventory: inv,
      }),
    ).toBeNull();
  });
});

describe("findAccountScopeListEntry", () => {
  it("enters a concrete team/workspace row from a scope-list page", () => {
    const inv = [
      el({ tag: "a", visibleText: "Teams", href: "/u/alice/teams", selector: "#teams" }),
      el({ tag: "a", visibleText: "Create team", href: "/u/alice/teams/new", selector: "#new" }),
      el({
        tag: "a",
        visibleText: "Alice engineering team",
        href: "/t/alice-engineering",
        selector: "#team",
      }),
    ];
    expect(
      findAccountScopeListEntry({
        currentUrl: "https://app.example.test/u/alice/teams",
        pageText: "Teams Create team",
        inventory: inv,
      })?.selector,
    ).toBe("#team");
  });

  it("ignores generic nav links on account settings pages", () => {
    const inv = [
      el({ tag: "a", visibleText: "Account", href: "/u/alice/settings/profile", selector: "#account" }),
      el({ tag: "a", visibleText: "Security", href: "/u/alice/settings/security", selector: "#security" }),
    ];
    expect(
      findAccountScopeListEntry({
        currentUrl: "https://app.example.test/u/alice/settings/profile",
        pageText: "Profile Security",
        inventory: inv,
      }),
    ).toBeNull();
  });

  it("does not treat the current account home link as a child scope row", () => {
    const inv = [
      el({ tag: "a", visibleText: "Home", href: "/u/alice", selector: "#home" }),
      el({ tag: "a", visibleText: "Create organisation", href: "/u/alice/orgs/new", selector: "#new" }),
    ];
    expect(
      findAccountScopeListEntry({
        currentUrl: "https://app.example.test/u/alice/orgs",
        pageText: "Organisations Create organisation",
        inventory: inv,
      }),
    ).toBeNull();
  });
});

describe("findPendingResourceSetupSubmit", () => {
  it("blocks navigation away from required resource setup forms", () => {
    const inv = [
      el({
        tag: "input",
        name: "spec.name",
        labelText: "Project name",
        selector: "#name",
      }),
      el({ tag: "button", visibleText: "Create project", selector: "#create" }),
    ];
    expect(findPendingResourceSetupSubmit(inv)?.selector).toBe("#create");
  });

  it("does not mistake credential creation for resource setup", () => {
    const inv = [
      el({ tag: "input", name: "key_name", labelText: "Key name", selector: "#name" }),
      el({ tag: "button", visibleText: "Create API key", selector: "#create" }),
    ];
    expect(findPendingResourceSetupSubmit(inv)).toBeNull();
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

  it("prefers a concrete resource submit over a generic create-new header button", () => {
    const inv = [
      el({ tag: "button", visibleText: "Create new", selector: "#header" }),
      el({ tag: "button", type: "submit", visibleText: "Create project", selector: "#project" }),
    ];
    expect(pickOnboardingSubmit(inv)?.selector).toBe("#project");
  });

  it("returns null when there are no buttons", () => {
    expect(pickOnboardingSubmit([el({ tag: "input", name: "x" })])).toBeNull();
  });
});

describe("isOnboardingForwardLabel", () => {
  it("recognizes create-resource submit buttons as wizard-forward controls", () => {
    for (const label of [
      "Create organization",
      "Create workspace",
      "Create project",
      "Set up organization",
    ]) {
      expect(isOnboardingForwardLabel(label)).toBe(true);
    }
  });

  it("does not treat arbitrary create labels as wizard-forward controls", () => {
    expect(isOnboardingForwardLabel("Create API key")).toBe(false);
  });
});

describe("retargetCredentialAppTypeChoice", () => {
  it("retargets machine-to-machine app cards to regular web app cards", () => {
    const inv = [
      el({
        tag: "div",
        role: "button",
        visibleText: "Single-Page App Javascript web app that runs in the browser",
        selector: "#spa",
      }),
      el({
        tag: "div",
        role: "button",
        visibleText: "Regular Web App Traditional web app that runs on the server",
        selector: "#web",
      }),
      el({
        tag: "div",
        role: "button",
        visibleText: "Machine to Machine A server or script calling APIs without a user involved",
        selector: "#m2m",
      }),
    ];
    const retargeted = retargetCredentialAppTypeChoice(
      { kind: "click", selector: "#m2m", reason: "Select app type" },
      inv,
    );
    expect(retargeted.kind).toBe("click");
    expect("selector" in retargeted && retargeted.selector).toBe("#web");
  });

  it("retargets frontend framework choices to backend runtimes for credential-bearing apps", () => {
    const inv = [
      el({ tag: "div", role: "button", visibleText: "React", selector: "#react" }),
      el({ tag: "div", role: "button", visibleText: "Next.js", selector: "#next" }),
      el({ tag: "div", role: "button", visibleText: "Python", selector: "#python" }),
      el({ tag: "div", role: "button", visibleText: "Vue", selector: "#vue" }),
    ];
    const retargeted = retargetCredentialAppTypeChoice(
      { kind: "click", selector: "#react", reason: "Select technology" },
      inv,
    );
    expect(retargeted.kind).toBe("click");
    expect("selector" in retargeted && retargeted.selector).toBe("#python");
  });

  it("keeps ordinary click choices unchanged", () => {
    const step = { kind: "click" as const, selector: "#personal", reason: "Choose personal" };
    expect(
      retargetCredentialAppTypeChoice(step, [
        el({ tag: "button", role: "button", visibleText: "Personal", selector: "#personal" }),
      ]),
    ).toBe(step);
  });
});

describe("coerceCheckboxClickStep", () => {
  it("converts planner clicks on checkbox inputs into idempotent check steps", () => {
    const step = coerceCheckboxClickStep(
      { kind: "click", selector: "#tos", reason: "Accept terms" },
      [el({ tag: "input", type: "checkbox", selector: "#tos", labelText: "I accept" })],
    );
    expect(step.kind).toBe("check");
    expect("selector" in step && step.selector).toBe("#tos");
  });

  it("leaves ordinary clicks unchanged", () => {
    const step = { kind: "click" as const, selector: "#continue", reason: "Continue" };
    expect(
      coerceCheckboxClickStep(step, [
        el({ tag: "button", type: "button", selector: "#continue", visibleText: "Continue" }),
      ]),
    ).toBe(step);
  });
});

describe("retargetSubmitToDefaultedPicker", () => {
  it("clicks a button-shaped required-looking parent resource picker before submit", () => {
    const retargeted = retargetSubmitToDefaultedPicker(
      { kind: "click", selector: "#continue", reason: "Continue" },
      [
        el({ tag: "button", visibleText: "Continue", selector: "#continue" }),
        el({
          tag: "button",
          visibleText: "businessSelect parent resource",
          selector: "#parent-resource",
        }),
      ],
    );
    expect(retargeted.kind).toBe("click");
    expect("selector" in retargeted && retargeted.selector).toBe("#parent-resource");
  });

  it("uses select for true combobox pickers", () => {
    const retargeted = retargetSubmitToDefaultedPicker(
      { kind: "click", selector: "#continue", reason: "Continue" },
      [
        el({ tag: "button", visibleText: "Continue", selector: "#continue" }),
        el({
          tag: "button",
          role: "combobox",
          visibleText: "Select workspace",
          selector: "#workspace",
        }),
      ],
    );
    expect(retargeted.kind).toBe("select");
    expect("selector" in retargeted && retargeted.selector).toBe("#workspace");
  });

  it("leaves submit clicks alone when no defaulted picker is visible", () => {
    const step = { kind: "click" as const, selector: "#continue", reason: "Continue" };
    expect(
      retargetSubmitToDefaultedPicker(step, [
        el({ tag: "button", visibleText: "Continue", selector: "#continue" }),
      ]),
    ).toBe(step);
  });

  it("does not retarget action buttons inside an already-open picker dialog", () => {
    const step = {
      kind: "click" as const,
      selector: "resource-selector-dialog > dialog-actions > button:nth-of-type(2)",
      reason: "Done",
    };
    expect(
      retargetSubmitToDefaultedPicker(step, [
        el({
          tag: "button",
          visibleText: "Done",
          selector: "resource-selector-dialog > dialog-actions > button:nth-of-type(2)",
        }),
        el({
          tag: "button",
          visibleText: "businessSelect parent resource",
          selector: "#parent-resource",
        }),
      ]),
    ).toBe(step);
  });
});

describe("isAuthEntryPageForPreExtraction", () => {
  it("flags signup pages with provider buttons so visible samples do not short-circuit signup", () => {
    expect(
      isAuthEntryPageForPreExtraction({
        url: "https://app.acme.com/signup",
        html: "<html><body>Sign up</body></html>",
        inventory: [
          el({ tag: "button", type: "button", visibleText: "Sign up with GitHub" }),
          el({ tag: "button", type: "button", visibleText: "Sign up with email" }),
        ],
      }),
    ).toBe(true);
  });

  it("does not flag authenticated API-key settings pages", () => {
    expect(
      isAuthEntryPageForPreExtraction({
        url: "https://app.acme.com/settings/api-keys",
        html: "<html><body>API keys Create key</body></html>",
        inventory: [
          el({ tag: "button", type: "button", visibleText: "Create API key" }),
          el({ tag: "button", type: "button", visibleText: "Log out" }),
        ],
      }),
    ).toBe(false);
  });
});

describe("pickOnboardingLeafChoice", () => {
  it("picks a leaf role before submitting a parent/child role wizard", () => {
    const inv = [
      el({ tag: "button", visibleText: "Let's Get Started", selector: "#submit" }),
      el({ tag: "button", visibleText: "Developer", selector: "#parent" }),
      el({ tag: "button", visibleText: "Full Stack Developer", selector: "#leaf" }),
    ];
    expect(pickOnboardingLeafChoice(inv)?.selector).toBe("#leaf");
  });

  it("treats code/API usage cards as developer parent choices (Cloudinary)", () => {
    const inv = [
      el({ tag: "button", visibleText: "Next", selector: "#next" }),
      el({ tag: "button", visibleText: "I write code and use APIs", selector: "#code" }),
      el({ tag: "button", visibleText: "Full Stack Developer", selector: "#full" }),
      el({ tag: "button", visibleText: "Back End Developer", selector: "#back" }),
    ];
    expect(pickOnboardingLeafChoice(inv)?.selector).toBe("#full");
  });

  it("does not fire on ordinary one-level choice pages", () => {
    const inv = [
      el({ tag: "button", visibleText: "Next", selector: "#next" }),
      el({ tag: "button", visibleText: "Personal", selector: "#personal" }),
    ];
    expect(pickOnboardingLeafChoice(inv)).toBeNull();
  });

  it("skips leaf roles already tried", () => {
    const inv = [
      el({ tag: "button", visibleText: "Let's Get Started", selector: "#submit" }),
      el({ tag: "button", visibleText: "Developer", selector: "#parent" }),
      el({ tag: "button", visibleText: "Back End Developer", selector: "#back" }),
      el({ tag: "button", visibleText: "Full Stack Developer", selector: "#full" }),
    ];
    expect(pickOnboardingLeafChoice(inv, new Set(["#back"]))?.selector).toBe("#full");
  });

  it("picks a concrete dev-stack option before a final get-started submit", () => {
    const inv = [
      el({ tag: "button", visibleText: "Let's Get Started", selector: "#submit" }),
      el({ tag: "button", visibleText: "Next.js", selector: "#nextjs" }),
      el({ tag: "button", visibleText: "Python", selector: "#python" }),
      el({ tag: "button", visibleText: "React", selector: "#react" }),
    ];
    expect(pickOnboardingLeafChoice(inv)?.selector).toBe("#nextjs");
  });
});
