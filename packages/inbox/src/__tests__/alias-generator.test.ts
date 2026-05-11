// Alias generation tests — format, sluggification, stability.

import { describe, expect, it } from "vitest";
import { accountHandle, generateAlias, serviceSlug } from "../alias-generator.js";

const ACCOUNT = "01HACCOUNTAAAAAAAAAAAAAAAA";
const RUN_ID = "01HRUNAAAAAAAAAAAAAAAAAAAA";

describe("generateAlias", () => {
  it("matches the documented format", () => {
    const alias = generateAlias(ACCOUNT, "resend", RUN_ID);
    // {handle}.{slug}.run-{runIdShort}@mail.trustysquire.ai
    expect(alias).toMatch(
      /^[0-9a-f]{8}\.resend\.run-01hrunaaaaaa@mail\.trustysquire\.ai$/,
    );
  });

  it("is stable for the same (account, service, run)", () => {
    const a = generateAlias(ACCOUNT, "resend", RUN_ID);
    const b = generateAlias(ACCOUNT, "resend", RUN_ID);
    expect(a).toBe(b);
  });

  it("differs across different runs", () => {
    const a = generateAlias(ACCOUNT, "resend", RUN_ID);
    const b = generateAlias(ACCOUNT, "resend", "01HRUNBBBBBBBBBBBBBBBBBBBB");
    expect(a).not.toBe(b);
  });

  it("differs across different accounts", () => {
    const a = generateAlias(ACCOUNT, "resend", RUN_ID);
    const b = generateAlias("01HACCOUNTBBBBBBBBBBBBBBBB", "resend", RUN_ID);
    expect(a).not.toBe(b);
  });

  it("respects domain override", () => {
    const alias = generateAlias(ACCOUNT, "resend", RUN_ID, { domain: "test.example" });
    expect(alias.endsWith("@test.example")).toBe(true);
  });
});

describe("serviceSlug", () => {
  it.each([
    ["Resend", "resend"],
    ["Stripe Atlas", "stripe-atlas"],
    ["Plaid_Link", "plaid-link"],
    ["fly.io", "fly-io"],
    ["__leading", "leading"],
    ["trailing__", "trailing"],
  ])("%s → %s", (input, expected) => {
    expect(serviceSlug(input)).toBe(expected);
  });
});

describe("accountHandle", () => {
  it("returns 8 lowercase hex chars", () => {
    const h = accountHandle(ACCOUNT);
    expect(h).toMatch(/^[0-9a-f]{8}$/);
  });

  it("differs for different account ids", () => {
    expect(accountHandle("a")).not.toBe(accountHandle("b"));
  });
});
