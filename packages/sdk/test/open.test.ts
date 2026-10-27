// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalOpenError, approvalPageUrl, openApproval, readPageMessage } from "../src/index.js";

const APPROVAL = {
  id: "01JD000000000000000000PAY1",
  approveUrl: "https://trustysquire.ai/vault/pay/01JD000000000000000000PAY1",
};
const SQUIRE = "https://trustysquire.ai";

function post(data: unknown, origin: string, source: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
}

function decision(status: string, approvalId = APPROVAL.id) {
  return { source: "trusty-squire", type: "approval.decision", approvalId, status };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("approvalPageUrl", () => {
  it("adds the mode and the return address the page will post to", () => {
    const sheet = new URL(approvalPageUrl(APPROVAL, "sheet", { returnOrigin: "https://app.test" }));
    expect(sheet.searchParams.get("embed")).toBe("sheet");
    expect(sheet.searchParams.get("return_origin")).toBe("https://app.test");
    const back = new URL(approvalPageUrl(APPROVAL, "redirect", { returnUrl: "beeline://approval" }));
    expect(back.searchParams.get("embed")).toBe("redirect");
    expect(back.searchParams.get("return_to")).toBe("beeline://approval");
    expect(back.searchParams.has("return_origin")).toBe(false);
  });

  it("refuses an approve URL that is not https", () => {
    expect(() => approvalPageUrl({ ...APPROVAL, approveUrl: "http://evil.test/x" }, "sheet")).toThrow(
      ApprovalOpenError,
    );
    expect(() => approvalPageUrl({ ...APPROVAL, approveUrl: "javascript:alert(1)" }, "sheet")).toThrow(
      ApprovalOpenError,
    );
  });
});

describe("readPageMessage", () => {
  it("accepts only this approval's messages with a known status", () => {
    expect(readPageMessage(decision("approved"), APPROVAL.id)?.status).toBe("approved");
    expect(readPageMessage(decision("approved", "other"), APPROVAL.id)).toBeNull();
    expect(readPageMessage(decision("hacked"), APPROVAL.id)).toBeNull();
    expect(readPageMessage({ ...decision("approved"), source: "x" }, APPROVAL.id)).toBeNull();
    expect(readPageMessage("approved", APPROVAL.id)).toBeNull();
  });
});

describe("openApproval sheet", () => {
  function mounted() {
    const overlay = document.querySelector<HTMLElement>("[data-trusty-squire-sheet]");
    const frame = overlay?.querySelector("iframe") ?? null;
    return { overlay, frame };
  }

  it("shows the Squire page in a sheet with its address and the passkey permission", async () => {
    const outcome = openApproval(APPROVAL);
    const { overlay, frame } = mounted();
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector("[data-trusty-squire-address]")?.textContent).toBe(
      `trustysquire.ai/vault/pay/${APPROVAL.id}`,
    );
    expect(frame?.getAttribute("allow")).toContain(`publickey-credentials-get ${SQUIRE}`);
    const src = new URL(frame!.getAttribute("src")!);
    expect(src.origin).toBe(SQUIRE);
    expect(src.searchParams.get("embed")).toBe("sheet");
    expect(src.searchParams.get("return_origin")).toBe(window.location.origin);

    post(decision("approved"), SQUIRE, frame!.contentWindow);
    await expect(outcome).resolves.toEqual({ approvalId: APPROVAL.id, status: "approved" });
    // The user sees the result briefly; "Return to app" closes it at once.
    expect(mounted().overlay).not.toBeNull();
    post({ source: "trusty-squire", type: "approval.close", approvalId: APPROVAL.id }, SQUIRE, frame!.contentWindow);
    expect(mounted().overlay).toBeNull();
  });

  it("closes the sheet by itself after the decision", async () => {
    const outcome = openApproval(APPROVAL, { closeDelayMs: 5 });
    const { frame } = mounted();
    post(decision("completed"), SQUIRE, frame!.contentWindow);
    await expect(outcome).resolves.toMatchObject({ status: "completed" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mounted().overlay).toBeNull();
  });

  it("ignores messages from another origin or another window", async () => {
    const outcome = openApproval(APPROVAL);
    const { frame } = mounted();
    let settled = false;
    void outcome.then(() => (settled = true));
    post(decision("approved"), "https://evil.test", frame!.contentWindow);
    post(decision("approved"), SQUIRE, window);
    post(decision("pending"), SQUIRE, frame!.contentWindow);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(mounted().overlay).not.toBeNull();
    post(decision("denied"), SQUIRE, frame!.contentWindow);
    await expect(outcome).resolves.toMatchObject({ status: "denied" });
  });

  it("closes on abort", async () => {
    const controller = new AbortController();
    const outcome = openApproval(APPROVAL, { signal: controller.signal });
    controller.abort();
    await expect(outcome).resolves.toMatchObject({ status: "dismissed" });
    expect(mounted().overlay).toBeNull();
  });

  it("resolves dismissed when the user closes the sheet", async () => {
    const outcome = openApproval(APPROVAL);
    document.querySelector<HTMLButtonElement>("[data-trusty-squire-sheet] button")!.click();
    await expect(outcome).resolves.toEqual({ approvalId: APPROVAL.id, status: "dismissed" });
  });

  it("redirects when the page reports it cannot run passkeys here", async () => {
    const assign = vi.fn();
    const location = window.location;
    vi.spyOn(window, "location", "get").mockReturnValue({ ...location, assign, href: "https://app.test/chat" } as Location);
    const outcome = openApproval(APPROVAL, { returnUrl: "https://app.test/chat#c1" });
    const { frame } = mounted();
    post({ source: "trusty-squire", type: "approval.fallback", approvalId: APPROVAL.id }, SQUIRE, frame!.contentWindow);
    await expect(outcome).resolves.toMatchObject({ status: "redirected" });
    const target = new URL(assign.mock.calls[0]![0] as string);
    expect(target.searchParams.get("embed")).toBe("redirect");
    expect(target.searchParams.get("return_to")).toBe("https://app.test/chat#c1");
    expect(mounted().overlay).toBeNull();
  });
});

describe("openApproval popup", () => {
  it("opens a popup and resolves on its decision only", async () => {
    const popup = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const outcome = openApproval(APPROVAL, { mode: "popup" });
    const url = new URL(open.mock.calls[0]![0] as string);
    expect(url.searchParams.get("embed")).toBe("popup");
    expect(url.searchParams.get("return_origin")).toBe(window.location.origin);
    post(decision("approved"), SQUIRE, window);
    post(decision("approved"), SQUIRE, popup);
    await expect(outcome).resolves.toEqual({ approvalId: APPROVAL.id, status: "approved" });
  });

  it("rejects when the popup is blocked", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    await expect(openApproval(APPROVAL, { mode: "popup" })).rejects.toMatchObject({ code: "popup_blocked" });
  });
});
