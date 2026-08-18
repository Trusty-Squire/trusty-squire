// Money-path security: the manual card-entry guard. A model-supplied
// operate_act `type` value that is card-number-shaped (13–19 digits, Luhn-valid,
// spaces/hyphens allowed as grouping) is refused with terminal operate_pay
// guidance — a model must never type a PAN into a page. Luhn (not just length)
// keeps order/tracking numbers from false-positiving. The act()-level wiring is
// covered in operate-session-flow.test.ts; operate_pay's sanctioned vaulted-card
// fill staying un-gated is covered in pay-operator.test.ts.
import { describe, it, expect } from "vitest";
import { manualCardEntryBlockReason } from "../provision-session.js";

describe("manualCardEntryBlockReason", () => {
  it("refuses a Luhn-valid card number typed plain", () => {
    expect(manualCardEntryBlockReason("5555555555554444")).toMatch(/operate_pay/);
  });

  it("refuses a Luhn-valid card number with space grouping", () => {
    expect(manualCardEntryBlockReason("5555 5555 5555 4444")).toMatch(/operate_pay/);
  });

  it("refuses a Luhn-valid card number with hyphen grouping", () => {
    expect(manualCardEntryBlockReason("5555-5555-5555-4444")).toMatch(/operate_pay/);
  });

  it("refuses non-16-length card shapes too (Amex 15, Visa 13-19 range)", () => {
    // Amex test number (15 digits, Luhn-valid).
    expect(manualCardEntryBlockReason("378282246310005")).toMatch(/operate_pay/);
    // 19-digit Luhn-valid PAN.
    expect(manualCardEntryBlockReason("6221261111111111113")).toMatch(/operate_pay/);
  });

  it("refuses a card number embedded in surrounding text", () => {
    expect(manualCardEntryBlockReason("card: 4242 4242 4242 4242 please")).toMatch(/operate_pay/);
  });

  it("never echoes the card number back in the refusal", () => {
    const reason = manualCardEntryBlockReason("5555 5555 5555 4444");
    expect(reason).not.toBeNull();
    expect(reason).not.toContain("5555");
    expect(reason).not.toContain("4444");
  });

  it("allows ordinary text", () => {
    expect(manualCardEntryBlockReason("Brooklyn")).toBeNull();
    expect(manualCardEntryBlockReason("lunchbox@example.com")).toBeNull();
    expect(manualCardEntryBlockReason("")).toBeNull();
  });

  it("allows a 16-digit NON-Luhn value (an order number)", () => {
    // 4242424242424242 is Luhn-valid; flipping the last digit breaks the checksum.
    expect(manualCardEntryBlockReason("4242424242424243")).toBeNull();
    expect(manualCardEntryBlockReason("1234567890123456")).toBeNull();
  });

  it("allows digit runs outside the 13–19 PAN length range", () => {
    // 12 digits, Luhn-valid — too short to be a PAN.
    expect(manualCardEntryBlockReason("123456781236")).toBeNull();
    // 20+ digit runs are not PANs even if some substring would pass Luhn.
    expect(manualCardEntryBlockReason("42424242424242424242")).toBeNull();
  });

  it("allows phone numbers and short grouped digits", () => {
    expect(manualCardEntryBlockReason("555-555-5555")).toBeNull();
    expect(manualCardEntryBlockReason("+1 555 555 5555")).toBeNull();
  });
});
