import { describe, expect, it } from "vitest";
import {
  MAX_POST_VERIFY_NAVIGATES,
  MAX_PREMATURE_DONE_FALLBACKS,
  MAX_UPSTREAM_BLIP_RETRIES,
  PostSignupRecoveryFlow,
  PostSignupRecoveryState,
} from "../post-signup-recovery-state.js";

describe("PostSignupRecoveryState", () => {
  it("starts with the post-signup recovery budgets and empty mutable memory", () => {
    const state = new PostSignupRecoveryState();

    expect(MAX_UPSTREAM_BLIP_RETRIES).toBe(8);
    expect(MAX_PREMATURE_DONE_FALLBACKS).toBe(3);
    expect(MAX_POST_VERIFY_NAVIGATES).toBe(8);
    expect(state.prevInventorySize).toBe(-1);
    expect(state.clickSelectorsSinceInventoryChange.size).toBe(0);
    expect(state.actionEffects).toEqual([]);
    expect(state.triedFallbackUrls.size).toBe(0);
    expect(state.deadUrls.size).toBe(0);
  });

  it("keeps independent state per loop instance", () => {
    const first = new PostSignupRecoveryState();
    const second = new PostSignupRecoveryState();

    first.deadUrls.add("https://example.test/404");
    first.actionEffects.push({
      kind: "click",
      pageUnchanged: true,
      selector: "#create",
    });

    expect(second.deadUrls.size).toBe(0);
    expect(second.actionEffects).toEqual([]);
  });
});

describe("PostSignupRecoveryFlow", () => {
  it("turns a same-url navigate loop into a click replan hint", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);
    flow.recordNavigateExecution(
      "https://example.test/onboarding",
      "https://example.test/settings/api-keys",
    );

    const decision = flow.decideNavigate({
      url: "https://example.test/onboarding",
      targetUrl: "https://example.test/settings/api-keys",
      inventory: [
        {
          tag: "button",
          role: null,
          interactedThisRun: false,
          visibleText: "Continue",
          ariaLabel: null,
          labelText: null,
          selector: "#continue",
        },
      ],
    });

    expect(decision.kind).toBe("replan");
    expect(decision).toMatchObject({
      message:
        "Post-verify: navigate did not advance the page (URL still https://example.test/onboarding) — forcing a click on an inventory element.",
    });
    expect(decision.kind === "replan" ? decision.hint : "").toContain(
      "selector=#continue",
    );
    expect(state.prevNavigateFromUrl).toBeNull();
  });

  it("allows two click replans after the navigate budget before breaking", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);
    const input = {
      url: "https://example.test/dashboard",
      targetUrl: "https://example.test/keys",
      inventory: [
        {
          tag: "button",
          role: null,
          visibleText: "Settings",
          ariaLabel: null,
          labelText: null,
          selector: "#settings",
        },
      ],
    };

    for (let i = 0; i < MAX_POST_VERIFY_NAVIGATES; i++) {
      expect(flow.decideNavigate(input)).toEqual({ kind: "execute" });
    }
    expect(flow.decideNavigate(input).kind).toBe("replan");
    expect(flow.decideNavigate(input).kind).toBe("replan");
    const final = flow.decideNavigate(input);

    expect(final.kind).toBe("break");
    expect(final.kind === "break" ? final.doneReason : "").toContain(
      "exhausted the navigate budget",
    );
  });

  it("breaks a wait loop on an empty page after three rounds", () => {
    const flow = new PostSignupRecoveryFlow(new PostSignupRecoveryState());
    const input = {
      url: "https://example.test/callback",
      inventoryCount: 0,
      reason: "still loading",
    };

    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    const decision = flow.decideWait(input);

    expect(decision.kind).toBe("break");
    expect(decision.kind === "break" ? decision.doneReason : "").toContain(
      "0 interactive elements for 3 rounds",
    );
  });

  it("reloads once on repeated same-url waits, then breaks if still hung", () => {
    const flow = new PostSignupRecoveryFlow(new PostSignupRecoveryState());
    const input = {
      url: "https://example.test/redirect-auth",
      inventoryCount: 2,
      reason: "waiting",
    };

    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    const reload = flow.decideWait(input);
    expect(reload).toMatchObject({
      kind: "reload",
      url: "https://example.test/redirect-auth",
    });
    expect(flow.decideWait(input)).toEqual({ kind: "continue" });
    const final = flow.decideWait(input);

    expect(final.kind).toBe("break");
    expect(final.kind === "break" ? final.message : "").toContain(
      "page has elements but never advances",
    );
  });

  it("settles the first loading shell and navigates to root on the second", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);
    const input = {
      round: 4,
      path: "/callback",
      rootUrl: "https://example.test",
      currentUrl: "https://example.test/callback",
    };

    expect(flow.decideShell(input)).toMatchObject({
      kind: "settle",
      message:
        "Post-verify round 4: /callback is a loading shell (streak 1) — letting the SPA settle one more round",
    });
    expect(flow.decideShell(input)).toMatchObject({
      kind: "navigate_root",
      url: "https://example.test",
    });

    flow.recordShellRecovered();
    expect(state.shellStreak).toBe(0);
  });

  it("reloads once on repeated OAuth login-page rounds, then fails if still login", () => {
    const flow = new PostSignupRecoveryFlow(new PostSignupRecoveryState());
    const input = {
      isOAuthRun: true,
      isLoginPage: true,
      path: "/login",
      rootUrl: "https://example.test",
      currentUrl: "https://example.test/login",
    };

    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    const reload = flow.decideOAuthLoginPage(input);
    expect(reload).toMatchObject({
      kind: "reload",
      url: "https://example.test",
    });

    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    const fail = flow.decideOAuthLoginPage(input);
    expect(fail).toMatchObject({
      kind: "fail",
      rounds: 3,
    });
  });

  it("also treats login-form DOM on non-login URLs as OAuth login-page evidence", () => {
    const flow = new PostSignupRecoveryFlow(new PostSignupRecoveryState());
    const input = {
      isOAuthRun: true,
      isLoginPage: true,
      path: "/settings/api_keys",
      rootUrl: "https://cockroachlabs.cloud",
      currentUrl: "https://cockroachlabs.cloud/settings/api_keys",
    };

    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    expect(flow.decideOAuthLoginPage(input)).toEqual({ kind: "continue" });
    expect(flow.decideOAuthLoginPage(input)).toMatchObject({
      kind: "reload",
      url: "https://cockroachlabs.cloud",
    });
  });

  it("clears OAuth login-page rounds on non-login pages", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);

    expect(
      flow.decideOAuthLoginPage({
        isOAuthRun: true,
        isLoginPage: true,
        path: "/login",
        rootUrl: "https://example.test",
        currentUrl: "https://example.test/login",
      }),
    ).toEqual({ kind: "continue" });
    expect(state.consecutiveOauthLoginPageRounds).toBe(1);

    expect(
      flow.decideOAuthLoginPage({
        isOAuthRun: true,
        isLoginPage: false,
        path: "/dashboard",
        rootUrl: "https://example.test",
        currentUrl: "https://example.test/dashboard",
      }),
    ).toEqual({ kind: "clear" });
    expect(state.consecutiveOauthLoginPageRounds).toBe(0);
  });

  it("steers first failed extract toward fresh-key creation", () => {
    const state = new PostSignupRecoveryState();
    const decision = new PostSignupRecoveryFlow(state).decideFailedExtract();

    expect(decision.kind).toBe("masked_or_truncated");
    expect(decision.hint).toContain("masked or truncated");
    expect(state.consecutiveFailedExtracts).toBe(1);
  });

  it("replans off extract after two consecutive failed extracts", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);

    flow.decideFailedExtract();
    const decision = flow.decideFailedExtract();

    expect(decision.kind).toBe("replan");
    expect(decision.kind === "replan" ? decision.message : "").toContain(
      "2 consecutive failed extracts",
    );
    expect(decision.hint).toContain("Do NOT issue another 'extract'");
    expect(state.consecutiveFailedExtracts).toBe(0);
  });

  it("resets failed extract streak on extraction success", () => {
    const state = new PostSignupRecoveryState();
    const flow = new PostSignupRecoveryFlow(state);

    flow.decideFailedExtract();
    flow.recordExtractionSuccess();

    expect(state.consecutiveFailedExtracts).toBe(0);
  });
});
