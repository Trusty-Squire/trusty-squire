import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MandateReview } from "@/components/auth/MandateReview";
import { defaultPolicy, CATEGORY_LABELS } from "@/lib/mandate";

describe("MandateReview", () => {
  it("lists every allowed_categories entry with its display label", () => {
    const policy = defaultPolicy();
    render(<MandateReview policy={policy} expiresAt={new Date("2027-05-07T00:00:00Z")} />);
    for (const cat of policy.allowed_categories) {
      expect(screen.getByText(CATEGORY_LABELS[cat] ?? cat)).toBeInTheDocument();
    }
  });

  it("renders the spend limit in dollars", () => {
    const policy = { ...defaultPolicy(), spend_limit_cents_per_month: 25_000 };
    render(<MandateReview policy={policy} expiresAt={new Date("2027-05-07T00:00:00Z")} />);
    expect(screen.getByText(/\$250\.00/)).toBeInTheDocument();
  });

  it("omits the free-signup bullet when silent_signup.allow_free is false", () => {
    const policy = { ...defaultPolicy(), silent_signup: { ...defaultPolicy().silent_signup, allow_free: false } };
    render(<MandateReview policy={policy} expiresAt={new Date("2027-05-07T00:00:00Z")} />);
    expect(screen.queryByText(/Free signups in allowed categories/)).not.toBeInTheDocument();
  });
});
