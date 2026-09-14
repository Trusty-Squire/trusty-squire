// Checkout data types extracted from browser.ts (design PR 5 of
// data/ts-layer-contracts-design/report.md, §2.3 row "checkout parsers/reads").
//
// The caller-less checkout parsing/reads (summary/total/currency/line-item
// parsers, readCheckoutSummary, readCheckoutReviewSummary,
// readCheckoutReviewLineItems, clearCart, readSettledCheckoutReviewSummary)
// were deleted rather than moved: they were unsanctioned payment-blocking
// machinery with no production callers since #780 removed the V1 payment flow.

export interface CheckoutSummary {
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  // Set when sibling checkout frames render a different total/currency than
  // the one reported. A read-only report: the discrepancy is surfaced, never
  // a refusal that could block the purchase.
  total_conflict?: boolean;
}

export interface CheckoutCard {
  pan: string;
  exp_month: string;
  exp_year: string;
  name: string;
  cvv: string;
  issuer?: string;
  issuer_source?: "bin_metadata" | "vault_metadata" | "vault_label";
  network?: string;
  label?: string;
  billing: {
    line1: string;
    line2?: string;
    city: string;
    state?: string;
    postal_code: string;
    country: string;
  };
}
