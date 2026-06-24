import { describe, expect, it } from "vitest";
import {
  CredentialExtractionFlow,
  credentialFieldNames,
  extractAllLabeledTokensFromReason,
  hasAnyExtractedCredential,
  hasUsableCredentialBundle,
  type PostSignupExtractionRoundPort,
  isMultiCredBundle,
} from "../credential-extraction-flow.js";

describe("CredentialExtractionFlow credential policy", () => {
  it("excludes signup metadata and truncated stubs from credential fields", () => {
    expect(
      credentialFieldNames({
        api_key_truncated: "sk-123...",
        email: "user@example.com",
        password: "pw",
      }),
    ).toEqual([]);
  });

  it("treats one real extracted field as extraction progress", () => {
    expect(hasAnyExtractedCredential({ cloud_name: "demo" })).toBe(true);
  });

  it("keeps legacy api_key as a usable single-field credential", () => {
    expect(hasUsableCredentialBundle({ api_key: "sk-live" })).toBe(true);
  });

  it("keeps access_token as a usable single-field credential", () => {
    expect(hasUsableCredentialBundle({ access_token: "ddp_example_token" })).toBe(
      true,
    );
    expect(isMultiCredBundle({ access_token: "ddp_example_token" })).toBe(false);
  });

  it("treats a lone personal_api_key / project_api_key as single-sufficient", () => {
    // posthog mints a `phx_…` personal_api_key — a complete credential on its
    // own. It must end the post-signup loop, not bail oauth_onboarding_failed.
    expect(hasUsableCredentialBundle({ personal_api_key: "phx_abc123" })).toBe(true);
    expect(hasUsableCredentialBundle({ project_api_key: "phc_def456" })).toBe(true);
  });

  it("normalizes personal_api_key planner labels to a usable api_key", () => {
    expect(
      extractAllLabeledTokensFromReason(
        "The API key is visible: personal_api_key='ddp_example_token_123456'",
        "personal_api_key ddp_example_token_123456",
      ),
    ).toEqual({ api_key: "ddp_example_token_123456" });
  });

  it("accepts services that expose two named fields without literal api_key", () => {
    expect(
      hasUsableCredentialBundle({
        application_id: "app-123",
        app_secret: "secret-456",
      }),
    ).toBe(true);
  });

  it("rejects a lone non-secret identifier as a usable credential bundle", () => {
    expect(hasUsableCredentialBundle({ application_id: "app-123" })).toBe(false);
  });

  it("classifies fields beyond api_key/username as multi-credential mode", () => {
    expect(isMultiCredBundle({ api_key: "key", cloud_name: "demo" })).toBe(true);
    expect(isMultiCredBundle({ api_key: "key", username: "alice" })).toBe(false);
  });
});

function port(
  overrides: Partial<PostSignupExtractionRoundPort>,
): PostSignupExtractionRoundPort {
  return {
    extractText: async () => "",
    extractAllInputValues: async () => [],
    extractCredentials: async () => ({}),
    extractFromDomProximity: async () => ({}),
    revealMaskedCredentials: async () => ({ clicked: 0, diagnostic: [] }),
    extractLabeledCredentialCandidates: async () => [],
    countPresentedCredentialLabels: async () => 0,
    ...overrides,
  };
}

describe("CredentialExtractionFlow post-signup extraction round", () => {
  it("merges legacy and Phase E credentials first-wins", async () => {
    const credentials: Record<string, string> = { api_key: "legacy-first" };
    const result = await new CredentialExtractionFlow().runPostSignupExtractionRound({
      credentials,
      reason: "cloud_name='demo-cloud-1234'",
      round: 0,
      maxRounds: 5,
      detectPresentedCredentialLabels: false,
      port: port({
        extractText: async () => "demo-cloud-1234",
        extractCredentials: async () => ({ api_key: "legacy-second" }),
      }),
    });

    expect(credentials).toEqual({
      api_key: "legacy-first",
      cloud_name: "demo-cloud-1234",
    });
    expect(result.foundAnyCredential).toBe(true);
    expect(result.steps).toContain(
      "Post-verify 1/5: Phase E surfaced 1 labeled credential(s) (cloud_name=demo…1234)",
    );
  });

  it("runs reveal diagnostics and post-reveal DOM extraction for masked credentials", async () => {
    const credentials: Record<string, string> = {};
    const result = await new CredentialExtractionFlow().runPostSignupExtractionRound({
      credentials,
      reason: "api_secret is masked; reveal it",
      round: 1,
      maxRounds: 5,
      detectPresentedCredentialLabels: false,
      port: port({
        revealMaskedCredentials: async () => ({
          clicked: 1,
          diagnostic: ["clicked reveal"],
        }),
        extractFromDomProximity: async () => ({ api_secret: "secret-1234" }),
      }),
    });

    expect(credentials).toEqual({ api_secret: "secret-1234" });
    expect(result.foundAnyCredential).toBe(true);
    expect(result.steps).toContain(
      "Post-verify 2/5: reveal pass clicked=1 diagnostic=[clicked reveal]",
    );
    expect(result.steps).toContain(
      "Post-verify 2/5: post-reveal DOM-proximity extracted 1 more (api_secret)",
    );
  });

  it("reports presented credential count only when requested", async () => {
    const flow = new CredentialExtractionFlow();
    const credentials: Record<string, string> = {};

    const skipped = await flow.runPostSignupExtractionRound({
      credentials,
      reason: "extract",
      round: 0,
      maxRounds: 5,
      detectPresentedCredentialLabels: false,
      port: port({ countPresentedCredentialLabels: async () => 2 }),
    });
    expect(skipped.presentedCredentialCount).toBeNull();

    const counted = await flow.runPostSignupExtractionRound({
      credentials,
      reason: "extract",
      round: 0,
      maxRounds: 5,
      detectPresentedCredentialLabels: true,
      port: port({ countPresentedCredentialLabels: async () => 2 }),
    });
    expect(counted.presentedCredentialCount).toBe(2);
  });
});

describe("CredentialExtractionFlow post-click credential polling", () => {
  it("merges legacy credentials and stops once api_key appears", async () => {
    const credentials: Record<string, string> = {};
    let extractCalls = 0;

    const result = await new CredentialExtractionFlow().pollAfterCredentialProducingClick({
      credentials,
      maxPolls: 5,
      maxWaitMs: 10_000,
      port: {
        wait: async () => undefined,
        captureTransientAlert: async () => "",
        extractCredentials: async () => {
          extractCalls += 1;
          return extractCalls === 2 ? { api_key: "sk-live" } : {};
        },
        extractFromDomProximity: async () => ({}),
      },
    });

    expect(result).toEqual({ alertSeen: "", foundApiKey: true });
    expect(credentials).toEqual({ api_key: "sk-live" });
    expect(extractCalls).toBe(2);
  });

  it("merges DOM-proximity credentials without clobbering existing fields", async () => {
    const credentials: Record<string, string> = { api_key: "first" };

    await new CredentialExtractionFlow().pollAfterCredentialProducingClick({
      credentials,
      maxPolls: 1,
      maxWaitMs: 10_000,
      port: {
        wait: async () => undefined,
        captureTransientAlert: async () => "",
        extractCredentials: async () => ({ api_key: "second" }),
        extractFromDomProximity: async () => ({ api_secret: "secret-123" }),
      },
    });

    expect(credentials).toEqual({
      api_key: "first",
      api_secret: "secret-123",
    });
  });

  it("captures a transient alert once even when no key appears", async () => {
    const credentials: Record<string, string> = {};
    let alertCalls = 0;

    const result = await new CredentialExtractionFlow().pollAfterCredentialProducingClick({
      credentials,
      maxPolls: 3,
      maxWaitMs: 10_000,
      port: {
        wait: async () => undefined,
        captureTransientAlert: async () => {
          alertCalls += 1;
          return "operation failed";
        },
        extractCredentials: async () => ({}),
        extractFromDomProximity: async () => ({}),
      },
    });

    expect(result).toEqual({
      alertSeen: "operation failed",
      foundApiKey: false,
    });
    expect(alertCalls).toBe(1);
  });

  it("continues polling when legacy extraction throws mid-render", async () => {
    const credentials: Record<string, string> = {};
    let extractCalls = 0;

    const result = await new CredentialExtractionFlow().pollAfterCredentialProducingClick({
      credentials,
      maxPolls: 2,
      maxWaitMs: 10_000,
      port: {
        wait: async () => undefined,
        captureTransientAlert: async () => "",
        extractCredentials: async () => {
          extractCalls += 1;
          if (extractCalls === 1) throw new Error("execution context destroyed");
          return { api_key: "sk-after-render" };
        },
        extractFromDomProximity: async () => ({}),
      },
    });

    expect(result.foundApiKey).toBe(true);
    expect(credentials).toEqual({ api_key: "sk-after-render" });
  });
});
