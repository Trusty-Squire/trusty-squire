// Default policy + helpers for rendering the mandate body.
//
// The actual mandate that gets signed is canonicalized server-side; we
// compute the same shape here so the UI can show the user exactly what
// they're about to authorize.

export interface MandatePolicy {
  spend_limit_cents_per_month: number;
  allowed_categories: string[];
  silent_signup: { max_monthly_cost_cents: number; allow_free: boolean };
  approval_required_categories: string[];
  confidence_requirements: {
    login: "low" | "medium" | "high";
    mandate_signing: "low" | "medium" | "high";
    delta_mandate_signing: "low" | "medium" | "high";
    provision_silent: "low" | "medium" | "high";
    provision_approved: "low" | "medium" | "high";
    amend_mandate: "low" | "medium" | "high";
    cancel: "low" | "medium" | "high";
    rotate: "low" | "medium" | "high";
    release_identity: "low" | "medium" | "high";
  };
}

export const DEFAULT_CATEGORIES = [
  "hosting",
  "databases",
  "email-api",
  "object-storage",
  "auth-providers",
  "monitoring",
];

export const CATEGORY_LABELS: Record<string, string> = {
  hosting: "Hosting and deployment",
  databases: "Databases",
  "email-api": "Email APIs",
  "object-storage": "Object storage",
  "auth-providers": "Auth providers",
  monitoring: "Monitoring and logs",
};

export function defaultPolicy(): MandatePolicy {
  return {
    spend_limit_cents_per_month: 50_000,
    allowed_categories: DEFAULT_CATEGORIES,
    silent_signup: { max_monthly_cost_cents: 1000, allow_free: true },
    approval_required_categories: [],
    confidence_requirements: {
      login: "low",
      mandate_signing: "high",
      delta_mandate_signing: "high",
      provision_silent: "low",
      provision_approved: "medium",
      amend_mandate: "high",
      cancel: "low",
      rotate: "medium",
      release_identity: "high",
    },
  };
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatExpiry(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}
