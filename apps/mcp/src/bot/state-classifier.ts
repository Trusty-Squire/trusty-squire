import type { ObservationFrame } from "./observation-frame.js";

export type ProvisionFrameState =
  | "signup_form"
  | "oauth_provider_login"
  | "oauth_login_only"
  | "email_verification_pending"
  | "captcha_gate"
  | "api_key_surface"
  | "api_key_create_modal"
  | "account_review_gate"
  | "payment_gate"
  | "phone_gate"
  | "unknown";

export interface StateEvidence {
  kind: string;
  detail: string;
}

export interface Falsifier {
  kind: string;
  description: string;
}

export interface StateVerdict {
  state: ProvisionFrameState;
  confidence: number;
  evidence: StateEvidence[];
  falsifiers: Falsifier[];
}

interface FrameFacts {
  frame: ObservationFrame;
  text: string;
  url: string;
  hasEmail: boolean;
  hasPassword: boolean;
  hasButtonText(pattern: RegExp): boolean;
}

interface ClassifierRule {
  state: ProvisionFrameState;
  confidence: number | ((facts: FrameFacts) => number);
  matches(facts: FrameFacts): boolean;
  evidence: StateEvidence[] | ((facts: FrameFacts) => StateEvidence[]);
  falsifiers?: Falsifier[];
}

function materialize<T>(value: T | ((facts: FrameFacts) => T), facts: FrameFacts): T {
  return typeof value === "function" ? (value as (facts: FrameFacts) => T)(facts) : value;
}

function verdict(rule: ClassifierRule, facts: FrameFacts): StateVerdict {
  return {
    state: rule.state,
    confidence: materialize(rule.confidence, facts),
    evidence: materialize(rule.evidence, facts),
    falsifiers: rule.falsifiers ?? [],
  };
}

function textOf(frame: ObservationFrame): string {
  return `${frame.state.title}\n${frame.visibleText}`.toLowerCase();
}

function hasVisibleInput(frame: ObservationFrame, types: readonly string[]): boolean {
  return frame.inventory.some(
    (element) =>
      element.visible === true &&
      element.tag === "input" &&
      element.type !== null &&
      types.includes(element.type),
  );
}

function hasVisibleButtonText(frame: ObservationFrame, pattern: RegExp): boolean {
  return frame.inventory.some((element) => {
    if (element.visible !== true) return false;
    const label = [element.visibleText, element.labelText, element.ariaLabel, element.placeholder, element.iconLabel]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ");
    return pattern.test(label);
  });
}

function factsFor(frame: ObservationFrame): FrameFacts {
  return {
    frame,
    text: textOf(frame),
    url: frame.state.url.toLowerCase(),
    hasEmail: hasVisibleInput(frame, ["email"]),
    hasPassword: hasVisibleInput(frame, ["password"]),
    hasButtonText: (pattern) => hasVisibleButtonText(frame, pattern),
  };
}

const RULES: readonly ClassifierRule[] = [
  {
    state: "account_review_gate",
    confidence: 0.9,
    matches: ({ text }) => /waiting room|waitlist|pending review|account review|reviewing your account|approval pending/.test(text),
    evidence: [{ kind: "visible_text", detail: "Page text indicates account review / waiting room." }],
    falsifiers: [{ kind: "api_key_surface", description: "A visible API-key surface would falsify the review gate." }],
  },
  {
    state: "payment_gate",
    confidence: 0.82,
    matches: ({ text }) =>
      /add\s+(?:a\s+)?payment\s+method|payment\s+method\s+(?:is\s+)?required|add\s+(?:a\s+)?credit\s+card|credit\s+card\s+required|enter\s+(?:your\s+)?(?:card|payment)|billing\s+setup\s+(?:is\s+)?required|payment\s+required|upgrade\s+your\s+plan\s+to/.test(text),
    evidence: [{ kind: "visible_text", detail: "Page text indicates billing/payment is required." }],
    falsifiers: [{ kind: "free_key_surface", description: "A key surface reachable without billing would falsify the payment gate." }],
  },
  {
    state: "phone_gate",
    confidence: 0.82,
    matches: ({ text }) => /phone verification|verify your phone|enter your phone|sms code|text message/.test(text),
    evidence: [{ kind: "visible_text", detail: "Page text indicates phone/SMS verification is required." }],
    falsifiers: [{ kind: "non_phone_path", description: "A visible non-phone verification path would falsify the phone gate." }],
  },
  {
    state: "captcha_gate",
    confidence: 0.78,
    matches: ({ text }) => /complete the verification challenge|verify you are human|are you human|captcha|turnstile|cf-turnstile|recaptcha|hcaptcha/.test(text),
    evidence: [{ kind: "visible_text", detail: "Page text indicates a captcha or human-verification challenge." }],
    falsifiers: [{ kind: "inbox_email_arrived", description: "A verification email after submit can prove a managed captcha passed server-side." }],
  },
  {
    state: "email_verification_pending",
    confidence: 0.86,
    matches: ({ text }) => /check your email|verify your email|verification email|confirmation email|enter (?:the )?(?:code|otp)/.test(text),
    evidence: [{ kind: "visible_text", detail: "Page text indicates email verification is pending." }],
    falsifiers: [{ kind: "credential_visible", description: "Visible credentials would falsify the pending verification state." }],
  },
  {
    state: "oauth_login_only",
    confidence: 0.82,
    matches: ({ text }) => /couldn.t find your account|account doesn.t exist|no account found|sign in to continue/.test(text),
    evidence: [{ kind: "visible_text", detail: "Provider/app text indicates login-only OAuth for a new identity." }],
    falsifiers: [{ kind: "sign_up_transfer", description: "A successful provider signup transfer would falsify login-only OAuth." }],
  },
  {
    state: "oauth_provider_login",
    confidence: 0.74,
    matches: ({ url }) => /accounts\.google\.com|github\.com\/login|github\.com\/sessions|oauth|sso|sign[_-]?in/.test(url),
    evidence: ({ frame }) => [{ kind: "url", detail: `Provider/auth URL: ${frame.state.url}` }],
    falsifiers: [{ kind: "app_callback", description: "Returning to the app callback/dashboard would falsify provider-login state." }],
  },
  {
    state: "api_key_create_modal",
    confidence: 0.78,
    matches: ({ text, hasButtonText }) =>
      /api key|api token|access token|secret key|developer token|personal access token/.test(text) &&
      hasButtonText(/create|generate|new|issue|mint/i),
    evidence: [{ kind: "visible_text", detail: "API-key terminology plus create/generate affordance is visible." }],
    falsifiers: [{ kind: "credential_extracted", description: "Extracting a fresh credential would supersede create-modal state." }],
  },
  {
    state: "api_key_surface",
    confidence: 0.74,
    matches: ({ text }) => /api key|api token|access token|secret key|developer token|personal access token/.test(text),
    evidence: [{ kind: "visible_text", detail: "API-key/token terminology is visible." }],
    falsifiers: [{ kind: "no_extractable_or_creatable_key", description: "No visible value or create path would falsify key-surface readiness." }],
  },
  {
    state: "signup_form",
    confidence: ({ hasEmail, hasPassword }) => (hasEmail || hasPassword ? 0.8 : 0.65),
    matches: ({ hasEmail, hasPassword, hasButtonText }) =>
      hasEmail || hasPassword || hasButtonText(/sign up|create account|continue with email|start free/i),
    evidence: [{ kind: "inventory", detail: "Visible signup/email form affordances are present." }],
    falsifiers: [{ kind: "post_submit_transition", description: "A submitted form transitioning to verification/onboarding falsifies signup-form state." }],
  },
];

export function classifyObservationFrame(frame: ObservationFrame): StateVerdict {
  const facts = factsFor(frame);
  for (const rule of RULES) {
    if (rule.matches(facts)) return verdict(rule, facts);
  }
  return {
    state: "unknown",
    confidence: 0.2,
    evidence: [{ kind: "frame", detail: `No classifier matched frame ${frame.frameId}.` }],
    falsifiers: [],
  };
}
