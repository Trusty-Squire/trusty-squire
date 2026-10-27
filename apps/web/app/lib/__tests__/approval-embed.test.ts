import { describe, expect, it, vi } from "vitest";
import { readPageMessage, MESSAGE_SOURCE as SDK_SOURCE } from "../../../../../packages/sdk/src/open";
import {
  MESSAGE_SOURCE,
  hostStatus,
  isAllowedReturnOrigin,
  isAllowedReturnTo,
  passkeysAllowedHere,
  popupUrl,
  postToHost,
  readApprovalEmbed,
  returnToUrl,
} from "../approval-embed";

describe("return address checks", () => {
  it("accepts only an exact https origin, or loopback http", () => {
    expect(isAllowedReturnOrigin("https://app.example.com")).toBe(true);
    expect(isAllowedReturnOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedReturnOrigin("http://app.example.com")).toBe(false);
    expect(isAllowedReturnOrigin("https://app.example.com/chat")).toBe(false);
    expect(isAllowedReturnOrigin("*")).toBe(false);
    expect(isAllowedReturnOrigin("null")).toBe(false);
    expect(isAllowedReturnOrigin("javascript:alert(1)")).toBe(false);
  });

  it("accepts https, loopback http, and an app's own scheme as the redirect target", () => {
    expect(isAllowedReturnTo("https://app.example.com/chat?c=1")).toBe(true);
    expect(isAllowedReturnTo("beeline://approval")).toBe(true);
    expect(isAllowedReturnTo("http://127.0.0.1:3000/back")).toBe(true);
    expect(isAllowedReturnTo("http://app.example.com/back")).toBe(false);
    for (const unsafe of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:x",
      "file:///etc/passwd",
      "blob:https://x/1",
      "about:blank",
    ]) {
      expect(isAllowedReturnTo(unsafe)).toBe(false);
    }
  });
});

describe("readApprovalEmbed", () => {
  it("reads sheet and popup only with a valid return origin", () => {
    expect(readApprovalEmbed("?embed=sheet&return_origin=https%3A%2F%2Fapp.test")).toEqual({
      mode: "sheet",
      returnOrigin: "https://app.test",
      returnTo: null,
    });
    expect(readApprovalEmbed("?embed=popup&return_origin=https%3A%2F%2Fapp.test")?.mode).toBe("popup");
    expect(readApprovalEmbed("?embed=sheet&return_origin=http%3A%2F%2Fevil.test")).toBeNull();
    expect(readApprovalEmbed("?embed=sheet")).toBeNull();
    expect(readApprovalEmbed("")).toBeNull();
  });

  it("drops an unsafe redirect target but keeps redirect mode", () => {
    expect(readApprovalEmbed("?embed=redirect&return_to=javascript%3Aalert(1)")).toEqual({
      mode: "redirect",
      returnOrigin: null,
      returnTo: null,
    });
  });
});

describe("postToHost", () => {
  const decision = { type: "approval.decision" as const, approvalId: "a1", status: "approved" as const };

  it("posts a sheet's decision to the parent, addressed to the return origin only", () => {
    const parent = { postMessage: vi.fn() };
    const win = { parent } as unknown as Window;
    const embed = readApprovalEmbed("?embed=sheet&return_origin=https%3A%2F%2Fapp.test")!;
    expect(postToHost(embed, decision, win)).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: MESSAGE_SOURCE, ...decision },
      "https://app.test",
    );
  });

  it("posts a popup's decision to its opener, and nothing when standalone", () => {
    const opener = { postMessage: vi.fn() };
    const embed = readApprovalEmbed("?embed=popup&return_origin=https%3A%2F%2Fapp.test")!;
    expect(postToHost(embed, decision, { opener } as unknown as Window)).toBe(true);
    expect(opener.postMessage).toHaveBeenCalledWith(expect.anything(), "https://app.test");
    const top = {} as Window & { parent?: Window };
    top.parent = top;
    const sheet = readApprovalEmbed("?embed=sheet&return_origin=https%3A%2F%2Fapp.test")!;
    expect(postToHost(sheet, decision, top)).toBe(false);
  });

  it("speaks the message shape the SDK reads", () => {
    const parent = { postMessage: vi.fn() };
    const embed = readApprovalEmbed("?embed=sheet&return_origin=https%3A%2F%2Fapp.test")!;
    postToHost(embed, decision, { parent } as unknown as Window);
    expect(MESSAGE_SOURCE).toBe(SDK_SOURCE);
    expect(readPageMessage(parent.postMessage.mock.calls[0]![0], "a1")).toEqual({
      source: SDK_SOURCE,
      type: "approval.decision",
      approvalId: "a1",
      status: "approved",
    });
  });
});

describe("hostStatus", () => {
  it("keeps approved apart from done", () => {
    expect(hostStatus("payment", "submitted")).toBe("approved");
    expect(hostStatus("payment", "approved")).toBe("processing");
    expect(hostStatus("credential_fetch", "approved")).toBe("approved");
    expect(hostStatus("credential_fetch", "consumed")).toBe("completed");
    expect(hostStatus("credential_mutation", "approved")).toBe("completed");
    expect(hostStatus("card_mutation", "denied")).toBe("denied");
    expect(hostStatus("payment", "weird")).toBeNull();
  });
});

describe("helpers", () => {
  it("builds the redirect-back and popup URLs", () => {
    const embed = readApprovalEmbed("?embed=redirect&return_to=beeline%3A%2F%2Fapproval")!;
    const back = new URL(returnToUrl(embed, "a1", "denied")!);
    expect(back.protocol).toBe("beeline:");
    expect(back.searchParams.get("squire_approval_id")).toBe("a1");
    expect(back.searchParams.get("squire_approval_status")).toBe("denied");
    const popup = new URL(
      popupUrl("https://trustysquire.ai/vault/fetch/a1?embed=sheet&return_origin=https%3A%2F%2Fapp.test"),
    );
    expect(popup.searchParams.get("embed")).toBe("popup");
    expect(popup.searchParams.get("return_origin")).toBe("https://trustysquire.ai");
  });

  it("reads the frame's passkey permission when the browser exposes it", () => {
    const denied = { featurePolicy: { allowsFeature: () => false } } as unknown as Document;
    const allowed = { permissionsPolicy: { allowsFeature: () => true } } as unknown as Document;
    expect(passkeysAllowedHere(denied)).toBe(false);
    expect(passkeysAllowedHere(allowed)).toBe(true);
    expect(passkeysAllowedHere({} as Document)).toBe(true);
  });
});
