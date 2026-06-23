import { describe, expect, it } from "vitest";
import {
  PostSignupSyntheticCapture,
  type SyntheticCaptureEntry,
} from "../post-signup-synthetic-capture.js";
import type { BrowserState, InteractiveElement } from "../browser.js";

function state(): BrowserState {
  return {
    url: "https://example.test/dashboard/keys",
    title: "Keys",
    html: "<html>key</html>",
    screenshot: "jpeg",
  };
}

function inventory(): InteractiveElement[] {
  return [
    {
      index: 0,
      tag: "button",
      type: null,
      id: null,
      name: null,
      placeholder: null,
      ariaLabel: null,
      role: null,
      labelText: null,
      visibleText: "Create key",
      selector: "#create",
      visible: true,
      inViewport: true,
      inConsentWidget: false,
    },
  ];
}

describe("PostSignupSyntheticCapture", () => {
  it("merges implicit credentials and emits a synthetic extract capture", async () => {
    const captures: SyntheticCaptureEntry[] = [];
    const uploads: unknown[] = [];
    const credentials: Record<string, string> = {};

    const result = await new PostSignupSyntheticCapture().afterAction({
      service: "Example",
      loopRound: 4,
      capturedRound: 2,
      oauth: true,
      actionKind: "click",
      credentials,
      steps: [],
      resolvedModel: "model-a",
      resolvedProvider: "provider-a",
      roundUploader: async (input) => {
        uploads.push(input);
      },
      port: {
        extractCredentials: async () => ({ api_key: "sk-live" }),
        getState: async () => state(),
        buildInventory: async () => inventory(),
        captureRound: (entry) => {
          captures.push(entry);
        },
      },
    });

    expect(credentials).toEqual({ api_key: "sk-live" });
    expect(result).toEqual({ capturedRound: 3, haveNewCredentials: true });
    expect(captures).toHaveLength(1);
    expect(captures[0]?.round).toBe(2);
    expect(captures[0]?.observed).toEqual({
      kind: "extract",
      reason: "implicit extract after click — credentials surfaced on the page",
    });
    expect(captures[0]?.resolved_model).toBe("model-a");
    expect(captures[0]?.resolved_provider).toBe("provider-a");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      service: "Example",
      round: 5,
      kind: "extract",
      inventory_count: 1,
      observed_reason: "implicit extract after click — credentials surfaced on the page",
    });
  });

  it("does not capture when no new credential appears", async () => {
    const captures: SyntheticCaptureEntry[] = [];
    const credentials: Record<string, string> = {};

    const result = await new PostSignupSyntheticCapture().afterAction({
      service: "Example",
      loopRound: 0,
      capturedRound: 7,
      oauth: false,
      actionKind: "click",
      credentials,
      steps: [],
      port: {
        extractCredentials: async () => ({}),
        getState: async () => state(),
        buildInventory: async () => inventory(),
        captureRound: (entry) => {
          captures.push(entry);
        },
      },
    });

    expect(result).toEqual({ capturedRound: 7, haveNewCredentials: false });
    expect(captures).toEqual([]);
  });

  it("does not emit a synthetic capture for explicit extract actions", async () => {
    const captures: SyntheticCaptureEntry[] = [];
    const credentials: Record<string, string> = {};

    const result = await new PostSignupSyntheticCapture().afterAction({
      service: "Example",
      loopRound: 0,
      capturedRound: 7,
      oauth: false,
      actionKind: "extract",
      credentials,
      steps: [],
      port: {
        extractCredentials: async () => ({ api_key: "sk-live" }),
        getState: async () => state(),
        buildInventory: async () => inventory(),
        captureRound: (entry) => {
          captures.push(entry);
        },
      },
    });

    expect(credentials).toEqual({ api_key: "sk-live" });
    expect(result).toEqual({ capturedRound: 7, haveNewCredentials: true });
    expect(captures).toEqual([]);
  });

  it("keeps credentials when synthetic capture fails", async () => {
    const credentials: Record<string, string> = {};

    const result = await new PostSignupSyntheticCapture().afterAction({
      service: "Example",
      loopRound: 0,
      capturedRound: 1,
      oauth: false,
      actionKind: "click",
      credentials,
      steps: [],
      port: {
        extractCredentials: async () => ({ api_key: "sk-live" }),
        getState: async () => {
          throw new Error("page closed");
        },
        buildInventory: async () => inventory(),
        captureRound: () => {
          throw new Error("should not get here");
        },
      },
    });

    expect(credentials).toEqual({ api_key: "sk-live" });
    expect(result).toEqual({ capturedRound: 1, haveNewCredentials: true });
  });
});
