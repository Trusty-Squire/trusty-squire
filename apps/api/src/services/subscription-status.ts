// Single source of truth for "does this subscription unlock the paid
// tier?" — i.e. bypass the free-signup quota. Used by both the quota
// gate (inbox route) and the webhook normalization so the answer can't
// drift between writer and reader.
//
// "trialing" counts as unlocked: the card is attached and Stripe will
// bill at trial end. Everything else — "past_due", "canceled", "unpaid",
// "incomplete", and our "free" default — leaves the quota in force.

export function subscriptionUnlocksQuota(status: string): boolean {
  return status === "active" || status === "trialing";
}
