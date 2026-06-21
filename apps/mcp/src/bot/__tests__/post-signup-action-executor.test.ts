import { describe, expect, it } from "vitest";
import { PostSignupActionExecutor } from "../post-signup-action-executor.js";
import type {
  PostSignupActionBrowserPort,
  PostSignupActionExtractionPort,
} from "../post-signup-action-executor.js";

function browser(
  overrides: Partial<PostSignupActionBrowserPort> = {},
): PostSignupActionBrowserPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    click: async (selector) => {
      calls.push(`click:${selector}`);
    },
    type: async (selector, value) => {
      calls.push(`type:${selector}:${value}`);
    },
    selectOption: async (selector, optionText) => {
      calls.push(`select:${selector}:${optionText ?? ""}`);
    },
    check: async (selector) => {
      calls.push(`check:${selector}`);
    },
    scrollToEndOfTOS: async (selector) => {
      calls.push(`scroll:${selector ?? ""}`);
      return { reason: "ok", container: "modal" };
    },
    wait: async (seconds) => {
      calls.push(`wait:${seconds}`);
    },
    goto: async (url) => {
      calls.push(`goto:${url}`);
    },
    waitForInteractiveDom: async (minElements, timeoutMs) => {
      calls.push(`interactive:${minElements}:${timeoutMs}`);
    },
    captureTransientAlert: async (timeoutSeconds) => {
      calls.push(`alert:${timeoutSeconds}`);
      return "";
    },
    ...overrides,
  };
}

function extraction(
  overrides: Partial<PostSignupActionExtractionPort> = {},
): PostSignupActionExtractionPort {
  return {
    extractCredentials: async () => ({}),
    extractFromDomProximity: async () => ({}),
    ...overrides,
  };
}

describe("PostSignupActionExecutor", () => {
  it("executes navigate and waits for an interactive SPA surface", async () => {
    const b = browser();
    const result = await new PostSignupActionExecutor(
      b,
      extraction(),
      undefined,
      { clickPollMaxPolls: 1, clickPollMaxWaitMs: 10_000 },
    ).execute({
      step: { kind: "navigate", url: "https://example.test/api-keys", reason: "" },
      credentials: {},
      snapshotPostClickAlert: async () => undefined,
    });

    expect(result).toEqual({ steps: [], hint: undefined });
    expect(b.calls).toEqual([
      "goto:https://example.test/api-keys",
      "interactive:5:20000",
    ]);
  });

  it("turns scroll no-container into a replan hint", async () => {
    const b = browser({
      scrollToEndOfTOS: async () => ({ reason: "no_container", container: null }),
    });

    const result = await new PostSignupActionExecutor(
      b,
      extraction(),
      undefined,
      { clickPollMaxPolls: 1, clickPollMaxWaitMs: 10_000 },
    ).execute({
      step: { kind: "scroll", reason: "" },
      credentials: {},
      snapshotPostClickAlert: async () => undefined,
    });

    expect(result.steps).toEqual([
      "Post-verify: scroll requested but no scrollable container found — re-planning.",
    ]);
    expect(result.hint).toContain("NO scrollable container");
  });

  it("captures post-click alerts and returns a planner hint when no key appears", async () => {
    let snapshotted = false;
    const b = browser({
      captureTransientAlert: async () => "operation failed",
    });

    const result = await new PostSignupActionExecutor(
      b,
      extraction(),
      undefined,
      { clickPollMaxPolls: 1, clickPollMaxWaitMs: 10_000 },
    ).execute({
      step: { kind: "click", selector: "#create", reason: "" },
      credentials: {},
      snapshotPostClickAlert: async () => {
        snapshotted = true;
      },
    });

    expect(result.steps).toEqual([
      'Post-verify: the page showed a notification after the click: "operation failed"',
    ]);
    expect(result.hint).toContain("operation failed");
    expect(snapshotted).toBe(true);
  });

  it("merges credentials surfaced after click", async () => {
    const credentials: Record<string, string> = {};
    const b = browser();

    await new PostSignupActionExecutor(
      b,
      extraction({
        extractCredentials: async () => ({ api_key: "sk-live" }),
      }),
      undefined,
      { clickPollMaxPolls: 1, clickPollMaxWaitMs: 10_000 },
    ).execute({
      step: { kind: "click", selector: "#create", reason: "" },
      credentials,
      snapshotPostClickAlert: async () => undefined,
    });

    expect(credentials).toEqual({ api_key: "sk-live" });
  });

  it("commits react-select inputs with selectOption instead of raw typing", async () => {
    const b = browser();

    await new PostSignupActionExecutor(
      b,
      extraction(),
      undefined,
      { clickPollMaxPolls: 1, clickPollMaxWaitMs: 10_000 },
    ).execute({
      step: {
        kind: "fill",
        selector: "#react-select-2-input",
        value: "Software Engineer",
        reason: "",
      },
      credentials: {},
      snapshotPostClickAlert: async () => undefined,
    });

    expect(b.calls).toEqual(["select:#react-select-2-input:Software Engineer", "wait:1"]);
  });
});
