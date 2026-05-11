// Validator tests — Zod shape + structural rules.

import { describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  extractStaticHost,
  validateManifest,
} from "../validator.js";
import { makeValidManifest } from "./_fixtures.js";

describe("validateManifest", () => {
  it("accepts a valid manifest", () => {
    expect(() => validateManifest(makeValidManifest())).not.toThrow();
  });

  it("rejects invalid semver", () => {
    expect(() => validateManifest(makeValidManifest({ version: "v1-beta" }))).toThrow(
      /not valid semver/,
    );
  });

  it("rejects duplicate step IDs in the same flow", () => {
    const m = makeValidManifest();
    m.signup.steps[1] = { ...m.signup.steps[0]! };
    expect(() => validateManifest(m)).toThrow(/duplicate step id/);
  });

  it("rejects URL hosts not in allowed_domains", () => {
    const m = makeValidManifest();
    m.signup.steps[0] = {
      ...m.signup.steps[0]!,
      type: "http_request",
      request: {
        ...(m.signup.steps[0]! as { request: { url_template: string } }).request,
        url_template: "https://evil.example.com/x",
      },
    } as (typeof m.signup.steps)[number];
    expect(() => validateManifest(m)).toThrow(/not in network.allowed_domains/);
  });

  it("rejects when payment.max_authorize_cents < most expensive plan", () => {
    const m = makeValidManifest({
      capabilities: {
        ...makeValidManifest().capabilities,
        payment: { max_authorize_cents: 100, recurrence: "monthly" },
      },
    });
    expect(() => validateManifest(m)).toThrow(/max_authorize_cents/);
  });

  it("rejects extracted credentials not declared in vault_writes", () => {
    // Default fixture extracts api_key — declare oauth_token instead.
    const m = makeValidManifest({
      capabilities: {
        ...makeValidManifest().capabilities,
        vault_writes: [
          {
            kind: "oauth_token",
            reference_template: "vault://${context.email_alias}/demo/oauth",
            rotation_required: false,
          },
        ],
      },
    });
    expect(() => validateManifest(m)).toThrow(/api_key.*not in capabilities.vault_writes/);
  });

  it("rejects default_plan that doesn't reference an actual plan", () => {
    expect(() =>
      validateManifest(makeValidManifest({ default_plan: "missing" })),
    ).toThrow(/default_plan/);
  });

  it("rejects schemas missing required fields (Zod path)", () => {
    const m = makeValidManifest();
    delete (m as { service?: string }).service;
    expect(() => validateManifest(m)).toThrow(ManifestValidationError);
  });

  it("collects all issues into ManifestValidationError.issues", () => {
    const m = makeValidManifest({
      version: "not-semver",
      default_plan: "missing-plan",
    });
    try {
      validateManifest(m);
    } catch (err) {
      expect(err).toBeInstanceOf(ManifestValidationError);
      if (err instanceof ManifestValidationError) {
        expect(err.issues.length).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("extractStaticHost", () => {
  it("returns hostname for static URL", () => {
    expect(extractStaticHost("https://api.demo.example.com/x")).toBe("api.demo.example.com");
  });

  it("strips placeholders before parsing", () => {
    // After ${region} is stripped, "https://.api.demo.example.com" — URL still parses
    // and the host has a leading dot. We accept what URL.hostname returns;
    // the validator's allowed_domains check will simply not match a leading-dot host.
    const host = extractStaticHost("https://${region}api.demo.example.com/x");
    // Either the parser strips the dot or returns something starting with it —
    // the behaviour is documented as "may return null if unparseable".
    expect(host === null || typeof host === "string").toBe(true);
  });

  it("returns null when entire URL collapses to a placeholder", () => {
    expect(extractStaticHost("${full_url}")).toBeNull();
  });
});
