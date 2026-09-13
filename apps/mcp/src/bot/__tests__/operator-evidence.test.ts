import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { ConsoleMessage, Page } from "playwright";
import { CardValueOutputMask } from "../card-value-output-mask.js";
import { OperatorEvidenceCollector } from "../operator-evidence.js";

const CARD = { pan: "4111111111111111", cvv: "123" };

class FakeCdp extends EventEmitter {
  async send(method: string): Promise<Record<string, unknown>> {
    if (method === "Network.getResponseBody") {
      return {
        body: `{"card_number":"${CARD.pan}","cvv":"${CARD.cvv}","status":401}`,
      };
    }
    return {};
  }

  async detach(): Promise<void> {}
}

function fakePage(cdp: FakeCdp): Page {
  const events = new EventEmitter();
  return {
    context: () => ({ newCDPSession: async () => cdp }),
    url: () => "https://merchant.test/checkout",
    on: (event: string, listener: (...args: unknown[]) => void) => {
      events.on(event, listener);
      return undefined;
    },
    once: (event: string, listener: (...args: unknown[]) => void) => {
      events.once(event, listener);
      return undefined;
    },
    off: (event: string, listener: (...args: unknown[]) => void) => {
      events.off(event, listener);
      return undefined;
    },
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
  } as unknown as Page;
}

describe("operator evidence stream", () => {
  it("keeps pending, HTTP, transport, cancellation, and CORS evidence distinct and masked", async () => {
    const mask = new CardValueOutputMask();
    mask.register(CARD);
    const cdp = new FakeCdp();
    const page = fakePage(cdp);
    const evidence = new OperatorEvidenceCollector(mask);
    await evidence.attach(page);

    const request = (requestId: string, url: string, postData?: string) =>
      cdp.emit("Network.requestWillBeSent", {
        requestId,
        frameId: "frame-1",
        timestamp: 1,
        request: {
          method: "POST",
          url,
          headers: { "x-api-key": "api-visible", "x-card": CARD.pan },
          ...(postData === undefined ? {} : { postData }),
        },
      });

    request("http-401", `https://merchant.test/decline?pan=${CARD.pan}`, `cvv=${CARD.cvv}`);
    cdp.emit("Network.responseReceived", {
      requestId: "http-401",
      response: { status: 401, headers: { "x-cvv": CARD.cvv } },
    });
    cdp.emit("Network.loadingFinished", { requestId: "http-401", timestamp: 2 });
    request("pending", "https://merchant.test/pending");
    request("proxy", "https://merchant.test/proxy");
    cdp.emit("Network.loadingFailed", {
      requestId: "proxy",
      timestamp: 3,
      errorText: "net::ERR_PROXY_CONNECTION_FAILED",
    });
    request("canceled", "https://merchant.test/canceled");
    cdp.emit("Network.loadingFailed", {
      requestId: "canceled",
      timestamp: 4,
      errorText: "net::ERR_ABORTED",
      canceled: true,
    });
    request("cors", "https://other.test/cors");
    cdp.emit("Network.loadingFailed", {
      requestId: "cors",
      timestamp: 5,
      errorText: "net::ERR_FAILED",
      blockedReason: "other",
      corsErrorStatus: { corsError: "DisallowedByMode" },
    });
    (page as unknown as { emit: (event: string, value: unknown) => void }).emit("console", {
      type: () => "error",
      text: () => `declined ${CARD.pan}; security code ${CARD.cvv}`,
      location: () => ({
        url: "https://merchant.test/checkout.js",
        lineNumber: 1,
        columnNumber: 1,
      }),
    } satisfies Partial<ConsoleMessage>);
    (page as unknown as { emit: (event: string, value: unknown) => void }).emit(
      "pageerror",
      new Error(`processor rejected ${CARD.pan}; CVV ${CARD.cvv}`),
    );
    evidence.recordScreenshot({
      url: `https://merchant.test/checkout?pan=${CARD.pan}`,
      frame_url: null,
      full_page: false,
    });
    await Promise.resolve();

    const all = evidence.read();
    expect(all.network.find((record) => record.request_id === "http-401")).toMatchObject({
      state: "completed",
      status: 401,
      loading_failed: null,
    });
    expect(all.network.find((record) => record.request_id === "pending")).toMatchObject({
      state: "pending",
      status: null,
    });
    expect(all.network.find((record) => record.request_id === "proxy")?.loading_failed).toEqual({
      error_text: "net::ERR_PROXY_CONNECTION_FAILED",
      canceled: false,
      blocked_reason: null,
      cors_error: null,
    });
    expect(
      all.network.find((record) => record.request_id === "canceled")?.loading_failed,
    ).toMatchObject({
      error_text: "net::ERR_ABORTED",
      canceled: true,
      cors_error: null,
    });
    expect(
      all.network.find((record) => record.request_id === "cors")?.loading_failed,
    ).toMatchObject({
      canceled: false,
      blocked_reason: "other",
      cors_error: "DisallowedByMode",
    });
    expect(JSON.stringify(all)).not.toContain(CARD.pan);
    expect(JSON.stringify(all)).not.toMatch(/(?:cvv|security code)[^\n]{0,20}123/i);
    expect(JSON.stringify(all)).toContain("api-visible");
    expect(JSON.stringify(all)).toContain("401");
    expect(all.console.map((record) => record.kind)).toEqual(["console", "exception"]);

    const cursor = all.network.find((record) => record.request_id === "pending")!.seq - 1;
    const selected = evidence.read(cursor, "pending");
    expect(selected.network.map((record) => record.request_id)).toEqual(["pending"]);
    expect(selected.console).toEqual([]);
    expect(selected.screenshots).toEqual([]);
  });
});
