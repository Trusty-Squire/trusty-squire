// Wallet (payment-card) helpers shared by the vault list, the add-card
// component, and the pay page. Pure functions only — no React, no network —
// so the money-path logic (which brand, which last4, which bound card) is
// unit-testable without a DOM.

// The full trust promise shown with the card form. A whole-card "the server
// cannot read it" promise would be false now that brand + last4 are stored for
// display; the protected payload remains unreadable. Single source so the two
// add-card surfaces (/vault/card and the pay page) cannot drift.
export const CARD_TRUST_COPY =
  "Your full card number is encrypted in this browser and never readable by our servers. We store only the last 4 digits and card brand, for display.";

// Display-only card metadata a wallet row renders. `brand`/`last4` are null
// for legacy cards stored before the metadata columns existed.
export interface CardMeta {
  id: string;
  label: string;
  brand: string | null;
  last4: string | null;
  createdAt: string;
}

// Network brand from the card's IIN/BIN prefix. Display-only — a coarse match
// is fine; the value is never used to authorize anything. Returns a network
// name (no digits, so it satisfies the API's brand column regex) or null when
// the prefix is unknown, in which case the row falls back to a generic glyph.
export function detectCardBrand(pan: string): string | null {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 2) return null;
  if (/^4/.test(digits)) return "Visa";
  if (/^3[47]/.test(digits)) return "American Express";
  // Mastercard: 51-55 and the 2221-2720 range.
  if (/^5[1-5]/.test(digits) || /^2(2[2-9]|[3-6][0-9]|7[01]|720)/.test(digits)) {
    return "Mastercard";
  }
  if (/^6(011|5|4[4-9]|22)/.test(digits)) return "Discover";
  if (/^3(0[0-5]|[68])/.test(digits)) return "Diners Club";
  if (/^35(2[89]|[3-8][0-9])/.test(digits)) return "JCB";
  return null;
}

// Last four digits of a PAN, or null if there aren't four. The value the
// server stores for display; the plaintext full number never leaves this
// browser.
export function cardLast4(pan: string): string | null {
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

// A card with no stored metadata (legacy, pre-columns). Renders label-only
// with a "re-add to show ····" nudge rather than a fake last4.
export function isLegacyCard(card: Pick<CardMeta, "brand" | "last4">): boolean {
  return card.last4 === null;
}

// The metadata of the card a pending approval is SERVER-BOUND to, looked up
// by the approval's card_ref against the account's card list. This is the
// ONLY honest source for the last4 shown before the passkey ceremony — never
// local page state, never a post-passkey blob decrypt. Returns null when the
// approval is card-less or the bound id isn't in the list.
export function boundCardMeta(cardRef: string | null, cards: readonly CardMeta[]): CardMeta | null {
  if (cardRef === null) return null;
  return cards.find((card) => card.id === cardRef) ?? null;
}

// Approval-surface display identity for a bound card: "Label •••• 1234".
// Non-secret metadata only (label + last4), the same shape the vault renders
// from CardMeta; never PAN/expiry/CVV. A legacy card with no stored last4
// (last4 === null) renders label-only.
export function formatCardIdentity(card: Pick<CardMeta, "label" | "last4">): string {
  return card.last4 !== null ? `${card.label} •••• ${card.last4}` : card.label;
}

// Card networks the brand tile has a drawn mark for.
export type CardNetwork = "visa" | "mastercard" | "amex" | "discover" | "diners" | "jcb";

// Network from a stored brand string. Substring match so a brand that
// carries extra words (a bank co-brand like "Mastercard DBS") still maps
// to its network mark. Null/unknown → caller falls back to the monogram
// or the generic card glyph.
export function brandNetwork(brand: string | null): CardNetwork | null {
  if (brand === null) return null;
  const b = brand.toLowerCase();
  if (b.includes("visa")) return "visa";
  if (b.includes("mastercard")) return "mastercard";
  if (b.includes("american express") || b.includes("amex")) return "amex";
  if (b.includes("discover")) return "discover";
  if (b.includes("diners")) return "diners";
  if (b.includes("jcb")) return "jcb";
  return null;
}

// Short monogram fallback for the 28px brand tile when there is no drawn
// network mark — the vault's lettermark visual language (mono, muted).
// Null brand → caller renders the generic card glyph.
export function brandMonogram(brand: string | null): string | null {
  if (brand === null) return null;
  switch (brand) {
    case "Visa":
      return "V";
    case "Mastercard":
      return "MC";
    case "American Express":
      return "AX";
    case "Discover":
      return "D";
    case "Diners Club":
      return "DC";
    case "JCB":
      return "JCB";
    default:
      return brand.charAt(0).toUpperCase();
  }
}
