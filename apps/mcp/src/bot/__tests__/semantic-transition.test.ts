import { describe, expect, it } from "vitest";
import type { InteractiveElement } from "../browser.js";
import {
  classifySemanticFailure,
  evaluateSemanticTransition,
  inferSemanticTransition,
  scoreSemanticTransition,
} from "../semantic-transition.js";

function el(over: Partial<InteractiveElement>): InteractiveElement {
  return {
    index: 0,
    tag: "button",
    type: null,
    id: null,
    name: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    labelText: null,
    visibleText: null,
    selector: "#x",
    visible: true,
    inViewport: true,
    inConsentWidget: false,
    ...over,
  };
}

describe("semantic transition inference", () => {
  it("classifies create-key actions as credential lifecycle transitions", () => {
    const semantic = inferSemanticTransition({
      oauth: true,
      state: {
        url: "https://svc.test/settings/api-keys",
        title: "API Keys",
        html: "<h1>API Keys</h1><button>Create API Key</button>",
      },
      inventory: [el({ visibleText: "Create API Key", selector: "#create" })],
      observed: {
        kind: "click",
        selector: "#create",
        reason: "Create a fresh API key so the secret is visible once.",
      },
    });

    expect(semantic.intent.kind).toBe("create_credential");
    expect(semantic.likely_failure_bucket).toBe("credential_lifecycle_error");
    expect(semantic.predicate.kind).toBe("credential_created_or_modal_opened");
  });

  it("classifies account-type choices separately from credential navigation", () => {
    const semantic = inferSemanticTransition({
      oauth: true,
      state: {
        url: "https://svc.test/signup",
        title: "Choose account type",
        html: "<button>Individual developer</button><button>Company</button>",
      },
      inventory: [el({ visibleText: "Individual developer", selector: "#individual" })],
      observed: {
        kind: "click",
        selector: "#individual",
        reason: "Choose the individual developer path.",
      },
    });

    expect(semantic.intent.kind).toBe("choose_account_type");
    expect(semantic.likely_failure_bucket).toBe("wrong_persona_or_account_type");
  });

  it("scores semantic intent expectations independently from raw selectors", () => {
    const semantic = inferSemanticTransition({
      oauth: true,
      state: {
        url: "https://svc.test/developer/tokens",
        title: "Developer tokens",
        html: "<a>API Tokens</a>",
      },
      inventory: [el({ tag: "a", visibleText: "API Tokens", selector: "#tokens" })],
      observed: {
        kind: "click",
        selector: "#tokens",
        reason: "Open API tokens.",
      },
    });

    expect(
      scoreSemanticTransition(semantic, {
        accept_intents: ["navigate_to_credential_surface"],
        reject_intents: ["choose_account_type"],
        targets_any_of: ["API Tokens"],
      }),
    ).toEqual({
      pass: true,
      detail: "chose semantic intent navigate_to_credential_surface",
    });
  });

  it("marks a credential-surface navigation satisfied when post-state reaches tokens", () => {
    const before = {
      state: {
        url: "https://svc.test/dashboard",
        title: "Dashboard",
        html: "<a>Developer</a>",
      },
      inventory: [el({ tag: "a", visibleText: "Developer", selector: "#dev" })],
    };
    const semantic = inferSemanticTransition({
      oauth: true,
      ...before,
      observed: {
        kind: "click",
        selector: "#dev",
        reason: "Open developer API tokens.",
      },
    });

    const after = {
      state: {
        url: "https://svc.test/settings/api-tokens",
        title: "API Tokens",
        html: "<h1>API Tokens</h1><button>Create API Token</button>",
      },
      inventory: [el({ visibleText: "Create API Token", selector: "#create" })],
    };

    expect(evaluateSemanticTransition(semantic, before, after).predicate.verdict).toBe(
      "satisfied",
    );
  });

  it("marks an account-type transition violated when it reaches manual review", () => {
    const before = {
      state: {
        url: "https://svc.test/signup",
        title: "Choose account type",
        html: "<button>Individual</button><button>Company</button>",
      },
      inventory: [el({ visibleText: "Company", selector: "#company" })],
    };
    const semantic = inferSemanticTransition({
      oauth: true,
      ...before,
      observed: {
        kind: "click",
        selector: "#company",
        reason: "Choose company account.",
      },
    });

    const after = {
      state: {
        url: "https://svc.test/waiting-room",
        title: "Approval required",
        html: "<h1>Manual review</h1><label>Company name</label>",
      },
      inventory: [el({ visibleText: "Submit for approval", selector: "#submit" })],
    };

    expect(evaluateSemanticTransition(semantic, before, after).predicate.verdict).toBe(
      "violated",
    );
  });
});

describe("semantic failure classification", () => {
  it("separates wall/infra failures from planner failures", () => {
    expect(
      classifySemanticFailure({
        failureStage: "phone",
        error: "phone verification required",
        reachedOnboarding: true,
      }),
    ).toEqual({
      bucket: "anti_bot_or_human_gate",
      fault_class: "external_unwinnable_or_infra",
    });
  });

  it("classifies post-onboarding key-navigation loops as wrong product surface", () => {
    expect(
      classifySemanticFailure({
        failureStage: "planner_loop",
        error: "post-OAuth navigation did not surface an API key",
        reachedOnboarding: true,
      }),
    ).toEqual({
      bucket: "wrong_product_surface",
      fault_class: "planner_semantic_error",
    });
  });
});
