import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";
import type { FailureStage } from "./failure-stage.js";

export const SEMANTIC_TRANSITION_SCHEMA_VERSION = 1 as const;

export type SemanticIntentKind =
  | "choose_signup_route"
  | "choose_account_type"
  | "complete_onboarding_prerequisite"
  | "navigate_to_credential_surface"
  | "create_credential"
  | "extract_credentials"
  | "recover_from_wrong_surface"
  | "wait_for_state_change"
  | "finish_or_escalate";

export type SemanticFailureBucket =
  | "wrong_entry_url_or_auth_route"
  | "wrong_persona_or_account_type"
  | "wrong_product_surface"
  | "missing_onboarding_prerequisite"
  | "credential_lifecycle_error"
  | "fresh_vs_returning_identity_error"
  | "provider_session_or_mailbox_infra"
  | "anti_bot_or_human_gate"
  | "extraction_or_validation_error"
  | "unknown";

export type SemanticFaultClass =
  | "planner_semantic_error"
  | "executor_transition_error"
  | "external_unwinnable_or_infra"
  | "unknown";

export type PredicateVerdict = "unchecked" | "satisfied" | "violated" | "unknown";

export interface SemanticIntent {
  kind: SemanticIntentKind;
  target?: string;
  evidence: readonly string[];
}

export interface SemanticPredicate {
  kind: string;
  description: string;
  verdict: PredicateVerdict;
}

export interface SemanticTransitionRecord {
  schema_version: typeof SEMANTIC_TRANSITION_SCHEMA_VERSION;
  intent: SemanticIntent;
  expected_next_state: string;
  forbidden_states: readonly string[];
  predicate: SemanticPredicate;
  likely_failure_bucket: SemanticFailureBucket;
}

export interface SemanticTransitionInput {
  state: { url: string; title: string; html: string };
  inventory: readonly InteractiveElement[];
  observed: PostVerifyStep;
  oauth: boolean;
}

export interface SemanticTransitionExpectation {
  accept_intents: readonly SemanticIntentKind[];
  reject_intents?: readonly SemanticIntentKind[];
  targets_any_of?: readonly string[];
}

export interface SemanticTransitionScore {
  pass: boolean;
  detail: string;
}

export interface SemanticTransitionObservedState {
  state: { url: string; title: string; html: string };
  inventory: readonly InteractiveElement[];
  credentialPresent?: boolean;
}

function compactEvidence(items: readonly (string | undefined | null)[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    const trimmed = item?.replace(/\s+/g, " ").trim();
    if (trimmed === undefined || trimmed.length === 0) continue;
    if (!out.includes(trimmed)) out.push(trimmed.slice(0, 160));
    if (out.length >= 6) break;
  }
  return out;
}

function stepTarget(step: PostVerifyStep, inventory: readonly InteractiveElement[]): string | undefined {
  if (step.kind === "navigate") return step.url;
  if (
    step.kind !== "click" &&
    step.kind !== "fill" &&
    step.kind !== "select" &&
    step.kind !== "check"
  ) {
    return undefined;
  }
  const el = inventory.find((candidate) => candidate.selector === step.selector);
  const label =
    el?.visibleText ??
    el?.ariaLabel ??
    el?.labelText ??
    el?.placeholder ??
    el?.name ??
    step.selector;
  return `${label} (${step.selector})`;
}

function stepEvidence(input: SemanticTransitionInput, target: string | undefined): string[] {
  return compactEvidence([
    `url=${input.state.url}`,
    input.state.title.length > 0 ? `title=${input.state.title}` : undefined,
    target !== undefined ? `target=${target}` : undefined,
    `action=${input.observed.kind}`,
    input.observed.reason.length > 0 ? `reason=${input.observed.reason}` : undefined,
  ]);
}

function haystack(input: SemanticTransitionInput, target: string | undefined): string {
  const labels = input.inventory
    .slice(0, 40)
    .map((el) => `${el.visibleText ?? ""} ${el.ariaLabel ?? ""} ${el.labelText ?? ""} ${el.placeholder ?? ""}`)
    .join(" ");
  return `${input.state.url} ${input.state.title} ${input.state.html.slice(0, 4000)} ${target ?? ""} ${input.observed.reason} ${labels}`.toLowerCase();
}

function hasAny(text: string, words: readonly string[]): boolean {
  return words.some((word) => text.includes(word));
}

function classifyIntent(input: SemanticTransitionInput): {
  intent: SemanticIntentKind;
  bucket: SemanticFailureBucket;
  expectedNextState: string;
  forbiddenStates: readonly string[];
  predicateKind: string;
  predicateDescription: string;
} {
  const target = stepTarget(input.observed, input.inventory);
  const text = haystack(input, target);
  const credentialWords = ["api key", "apikey", "access token", "token", "secret", "credential", "developer", "personal access", "pat"];
  const createWords = ["create", "generate", "new key", "issue", "rotate", "regenerate", "reveal"];
  const accountWords = ["account type", "individual", "personal account", "company", "business"];
  const routeWords = ["google", "github", "oauth", "sso", "sign up", "signup", "continue with"];
  const onboardingWords = ["continue", "get started", "skip", "setup", "onboarding", "project", "workspace", "organization"];

  if (input.observed.kind === "extract") {
    return {
      intent: "extract_credentials",
      bucket: "extraction_or_validation_error",
      expectedNextState: "credential material is captured and validated",
      forbiddenStates: ["masked_or_truncated_key", "client_id_only", "domain_only", "no_secret_material"],
      predicateKind: "credential_extracted",
      predicateDescription: "At least one required credential field is present and passes validation.",
    };
  }

  if (input.observed.kind === "login") {
    return {
      intent: "choose_signup_route",
      bucket: input.oauth ? "fresh_vs_returning_identity_error" : "wrong_entry_url_or_auth_route",
      expectedNextState: "authenticated signup/onboarding session resumes",
      forbiddenStates: ["returning_login_wall", "wrong_provider_session", "account_already_exists"],
      predicateKind: "authenticated_session",
      predicateDescription: "The browser reaches the intended authenticated signup or dashboard state.",
    };
  }

  if (input.observed.kind === "done") {
    return {
      intent: "finish_or_escalate",
      bucket: "unknown",
      expectedNextState: "run stops with a justified terminal diagnosis",
      forbiddenStates: ["reachable_credential_affordance", "untried_onboarding_cta", "visible_create_key"],
      predicateKind: "terminal_diagnosis_supported",
      predicateDescription: "The page evidence supports stopping rather than continuing navigation.",
    };
  }

  if (input.observed.kind === "wait") {
    return {
      intent: "wait_for_state_change",
      bucket: "provider_session_or_mailbox_infra",
      expectedNextState: "page changes after an asynchronous redirect, hydration, or verification wait",
      forbiddenStates: ["same_url_same_inventory_wait_loop", "empty_shell_timeout"],
      predicateKind: "state_changed",
      predicateDescription: "URL, title, inventory, or visible page text changes after the wait.",
    };
  }

  if (hasAny(text, createWords) && hasAny(text, credentialWords)) {
    return {
      intent: "create_credential",
      bucket: "credential_lifecycle_error",
      expectedNextState: "new credential material or a credential-creation modal becomes visible",
      forbiddenStates: ["existing_masked_key_only", "copy_old_key", "create_button_noop"],
      predicateKind: "credential_created_or_modal_opened",
      predicateDescription: "A new key/token/secret appears, or the page opens a form that creates one.",
    };
  }

  if (hasAny(text, accountWords)) {
    return {
      intent: "choose_account_type",
      bucket: "wrong_persona_or_account_type",
      expectedNextState: "self-serve individual/developer onboarding continues",
      forbiddenStates: ["company_approval_waiting_room", "sales_contact_form", "manual_review_form"],
      predicateKind: "self_serve_persona_selected",
      predicateDescription: "The route remains a self-serve signup rather than approval or sales flow.",
    };
  }

  if (hasAny(text, credentialWords)) {
    return {
      intent: "navigate_to_credential_surface",
      bucket: "wrong_product_surface",
      expectedNextState: "API keys, tokens, secrets, or developer credential surface is visible",
      forbiddenStates: ["client_app_only", "billing_page", "docs_page", "profile_only_settings"],
      predicateKind: "credential_surface_reached",
      predicateDescription: "The next state exposes credential affordances or credential material.",
    };
  }

  if (hasAny(text, routeWords)) {
    return {
      intent: "choose_signup_route",
      bucket: "wrong_entry_url_or_auth_route",
      expectedNextState: "the selected OAuth/email signup route advances to account creation",
      forbiddenStates: ["login_only_route", "unsupported_provider", "provider_account_chooser_loop"],
      predicateKind: "signup_route_advanced",
      predicateDescription: "The selected route enters signup/onboarding for the intended identity.",
    };
  }

  if (hasAny(text, onboardingWords)) {
    return {
      intent: "complete_onboarding_prerequisite",
      bucket: "missing_onboarding_prerequisite",
      expectedNextState: "required onboarding/setup step completes and dashboard navigation unlocks",
      forbiddenStates: ["wizard_loop", "company_required_gate", "project_creation_dead_end"],
      predicateKind: "onboarding_advanced",
      predicateDescription: "The browser leaves the blocking onboarding step or unlocks more dashboard navigation.",
    };
  }

  return {
    intent: "recover_from_wrong_surface",
    bucket: "wrong_product_surface",
    expectedNextState: "browser moves from an unproductive surface toward credential navigation",
    forbiddenStates: ["same_surface_loop", "irrelevant_marketing_or_docs_page"],
    predicateKind: "surface_changed_toward_credentials",
    predicateDescription: "URL or inventory changes toward settings, developer, API, token, or key surfaces.",
  };
}

export function inferSemanticTransition(input: SemanticTransitionInput): SemanticTransitionRecord {
  const target = stepTarget(input.observed, input.inventory);
  const classified = classifyIntent(input);
  return {
    schema_version: SEMANTIC_TRANSITION_SCHEMA_VERSION,
    intent: {
      kind: classified.intent,
      ...(target !== undefined ? { target } : {}),
      evidence: stepEvidence(input, target),
    },
    expected_next_state: classified.expectedNextState,
    forbidden_states: classified.forbiddenStates,
    predicate: {
      kind: classified.predicateKind,
      description: classified.predicateDescription,
      verdict: "unchecked",
    },
    likely_failure_bucket: classified.bucket,
  };
}

function stateText(input: SemanticTransitionObservedState): string {
  const labels = input.inventory
    .slice(0, 60)
    .map((el) => `${el.visibleText ?? ""} ${el.ariaLabel ?? ""} ${el.labelText ?? ""} ${el.placeholder ?? ""}`)
    .join(" ");
  return `${input.state.url} ${input.state.title} ${input.state.html.slice(0, 5000)} ${labels}`.toLowerCase();
}

function stateSignature(input: SemanticTransitionObservedState): string {
  return [
    input.state.url,
    input.state.title,
    input.inventory
      .map((el) => `${el.selector}:${el.visibleText ?? el.ariaLabel ?? el.labelText ?? ""}`)
      .join("|"),
  ].join("§");
}

function containsForbiddenState(text: string, forbiddenStates: readonly string[]): boolean {
  for (const forbidden of forbiddenStates) {
    switch (forbidden) {
      case "company_approval_waiting_room":
      case "sales_contact_form":
      case "manual_review_form":
        if (/\b(waiting room|approval|manual review|contact sales|company name|business email)\b/i.test(text)) {
          return true;
        }
        break;
      case "client_app_only":
      case "domain_only":
      case "client_id_only":
        if (/\b(client id|application id|callback url|redirect uri|domain)\b/i.test(text) && !/\b(secret|api key|token)\b/i.test(text)) {
          return true;
        }
        break;
      case "billing_page":
        if (/\b(billing|payment|credit card|subscribe|upgrade)\b/i.test(text)) return true;
        break;
      case "docs_page":
        if (/\b(documentation|docs|guide|tutorial)\b/i.test(text)) return true;
        break;
      case "login_only_route":
      case "returning_login_wall":
        if (/\b(sign in|log in|login)\b/i.test(text) && !/\b(sign up|create account)\b/i.test(text)) return true;
        break;
      default:
        if (text.includes(forbidden.replace(/_/g, " "))) return true;
    }
  }
  return false;
}

export function evaluateSemanticTransition(
  transition: SemanticTransitionRecord,
  before: SemanticTransitionObservedState,
  after: SemanticTransitionObservedState,
): SemanticTransitionRecord {
  const beforeSig = stateSignature(before);
  const afterSig = stateSignature(after);
  const changed = beforeSig !== afterSig;
  const afterText = stateText(after);
  const forbidden = containsForbiddenState(afterText, transition.forbidden_states);
  let verdict: PredicateVerdict = "unknown";

  if (forbidden) {
    verdict = "violated";
  } else {
    switch (transition.predicate.kind) {
      case "credential_extracted":
        verdict = after.credentialPresent === true ? "satisfied" : "violated";
        break;
      case "credential_created_or_modal_opened":
        verdict =
          after.credentialPresent === true ||
          /\b(create|generate|new|name).{0,40}\b(api key|token|secret|credential)\b/i.test(afterText) ||
          /\b(api key|token|secret|credential).{0,40}\b(created|generated|copy|shown|revealed)\b/i.test(afterText)
            ? "satisfied"
            : changed
              ? "unknown"
              : "violated";
        break;
      case "credential_surface_reached":
        verdict = /\b(api keys?|api tokens?|access tokens?|personal access tokens?|secrets?|credentials?|developers?)\b/i.test(afterText)
          ? "satisfied"
          : changed
            ? "unknown"
            : "violated";
        break;
      case "self_serve_persona_selected":
      case "signup_route_advanced":
      case "onboarding_advanced":
      case "authenticated_session":
      case "surface_changed_toward_credentials":
      case "state_changed":
        verdict = changed ? "satisfied" : "violated";
        break;
      case "terminal_diagnosis_supported":
        verdict = "unknown";
        break;
      default:
        verdict = changed ? "satisfied" : "unknown";
    }
  }

  return {
    ...transition,
    predicate: {
      ...transition.predicate,
      verdict,
    },
  };
}

export function classifySemanticFailure(input: {
  failureStage: FailureStage;
  error?: string;
  reachedOnboarding: boolean;
}): { bucket: SemanticFailureBucket; fault_class: SemanticFaultClass } {
  if (input.failureStage === "none") {
    return { bucket: "unknown", fault_class: "unknown" };
  }
  const err = (input.error ?? "").toLowerCase();
  if (
    input.failureStage === "captcha" ||
    input.failureStage === "anti_bot" ||
    input.failureStage === "phone" ||
    input.failureStage === "payment" ||
    input.failureStage === "manual" ||
    err.includes("waiting room") ||
    err.includes("manual review") ||
    err.includes("approval")
  ) {
    return { bucket: "anti_bot_or_human_gate", fault_class: "external_unwinnable_or_infra" };
  }
  if (
    input.failureStage === "oauth_handshake" ||
    input.failureStage === "account_chooser" ||
    input.failureStage === "consent"
  ) {
    return { bucket: "wrong_entry_url_or_auth_route", fault_class: "planner_semantic_error" };
  }
  if (input.failureStage === "verify_email" || input.failureStage === "proxy_timeout") {
    return { bucket: "provider_session_or_mailbox_infra", fault_class: "external_unwinnable_or_infra" };
  }
  if (input.failureStage === "hydration" || input.failureStage === "run_timeout") {
    return { bucket: "provider_session_or_mailbox_infra", fault_class: "executor_transition_error" };
  }
  if (input.failureStage === "extract") {
    if (err.includes("masked") || err.includes("already_signed_in") || err.includes("show-once")) {
      return { bucket: "credential_lifecycle_error", fault_class: "planner_semantic_error" };
    }
    return { bucket: "extraction_or_validation_error", fault_class: "planner_semantic_error" };
  }
  if (input.failureStage === "planner_loop") {
    if (err.includes("company") || err.includes("business") || err.includes("waiting room")) {
      return { bucket: "wrong_persona_or_account_type", fault_class: "planner_semantic_error" };
    }
    if (err.includes("api") || err.includes("key") || err.includes("token") || err.includes("credential")) {
      return { bucket: "wrong_product_surface", fault_class: "planner_semantic_error" };
    }
    return {
      bucket: input.reachedOnboarding ? "missing_onboarding_prerequisite" : "wrong_entry_url_or_auth_route",
      fault_class: "planner_semantic_error",
    };
  }
  if (input.failureStage === "form") {
    return { bucket: "wrong_entry_url_or_auth_route", fault_class: "planner_semantic_error" };
  }
  return { bucket: "unknown", fault_class: "unknown" };
}

export function scoreSemanticTransition(
  actual: SemanticTransitionRecord,
  expect: SemanticTransitionExpectation,
): SemanticTransitionScore {
  if (expect.reject_intents?.includes(actual.intent.kind) === true) {
    return {
      pass: false,
      detail: `chose semantic intent ${actual.intent.kind}, which is explicitly rejected`,
    };
  }
  if (!expect.accept_intents.includes(actual.intent.kind)) {
    return {
      pass: false,
      detail: `chose semantic intent ${actual.intent.kind}; expected ${expect.accept_intents.join("/")}`,
    };
  }
  if (expect.targets_any_of !== undefined) {
    const target = actual.intent.target ?? "";
    const matched = expect.targets_any_of.some((candidate) => target.includes(candidate));
    if (!matched) {
      return {
        pass: false,
        detail: `semantic target ${JSON.stringify(target)} did not match ${expect.targets_any_of.join(", ")}`,
      };
    }
  }
  return { pass: true, detail: `chose semantic intent ${actual.intent.kind}` };
}
