// End-to-end coverage for operate_screenshot through the REAL MCP tool-call
// path (InMemoryTransport, same harness as server-resilience.test.ts): a
// session, a mocked BrowserController.screenshotForOperator, and an assertion
// on the RAW protocol response — that a screenshot result actually arrives as
// an MCP `type: "image"` content block the host can render, not just a
// base64 string buried in JSON text.
import { describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { buildServer } from "../server.js";
import type { ApiClient } from "../api-client.js";
import type { BrowserController } from "../bot/browser.js";
import {
  closeAllProvisionSessions,
  startHarnessProvisionSession,
} from "../bot/provision-session.js";

async function connectedClient(): Promise<Client> {
  const api = { setRequestingAgent: vi.fn() } as unknown as ApiClient;
  const server = await buildServer(api);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "screenshot-tool-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AKgAf//Z";

describe("operate_screenshot — real MCP protocol round trip", () => {
  it("returns an MCP image content block, not just base64 buried in JSON", async () => {
    const url = "https://operator-screenshot.test/checkout";
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      recoverActivePage: vi.fn(),
      extractInteractiveElements: vi.fn().mockResolvedValue([]),
      extractVisibleText: vi.fn().mockResolvedValue("Checkout page"),
      currentUrl: vi.fn().mockReturnValue(url),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error("no checkout total")),
      close: vi.fn().mockResolvedValue(undefined),
      screenshotForOperator: vi.fn().mockResolvedValue({
        base64: TINY_JPEG_BASE64,
        frameUrl: null,
        frameCount: 1,
        redactedCount: 2,
      }),
    } as unknown as BrowserController;
    const started = await startHarnessProvisionSession({ serviceUrl: url, browser });
    const client = await connectedClient();

    try {
      const result = await client.callTool({
        name: "operate_screenshot",
        arguments: { session_id: started.session_id },
      });

      expect(result.isError).not.toBe(true);
      const content = result.content as Array<{
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }>;
      const imageBlock = content.find((c) => c.type === "image");
      expect(imageBlock).toBeDefined();
      expect(imageBlock?.data).toBe(TINY_JPEG_BASE64);
      expect(imageBlock?.mimeType).toBe("image/jpeg");

      // Metadata still rides the text block, WITHOUT a duplicated base64 blob.
      const textBlock = content.find((c) => c.type === "text");
      expect(textBlock?.text).toBeDefined();
      const meta = JSON.parse(textBlock?.text ?? "{}");
      expect(meta).toMatchObject({
        session_id: started.session_id,
        url,
        frame_url: null,
        frame_count: 1,
        redacted_count: 2,
      });
      expect(meta.image).toBeUndefined();
      expect(textBlock?.text ?? "").not.toContain(TINY_JPEG_BASE64);

      expect(
        (browser.screenshotForOperator as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
      ).toEqual({ extraRedactionSelectors: [] });
    } finally {
      await client.close();
      await closeAllProvisionSessions();
    }
  });

  it("passes frame args and the session's sealed-field selectors through to the browser layer", async () => {
    const url = "https://operator-screenshot.test/checkout";
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      recoverActivePage: vi.fn(),
      // One field sealed via the ref-based type_secret path (session-tracked,
      // no DOM marker) and one ordinary field: only the sealed one's selector
      // may reach the capture's redaction set.
      extractInteractiveElements: vi.fn().mockResolvedValue([
        { selector: "#otp-code", sealed: true },
        { selector: "#promo-code", sealed: false },
      ]),
      extractVisibleText: vi.fn().mockResolvedValue("Checkout page"),
      currentUrl: vi.fn().mockReturnValue(url),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error("no checkout total")),
      close: vi.fn().mockResolvedValue(undefined),
      screenshotForOperator: vi.fn().mockResolvedValue({
        base64: TINY_JPEG_BASE64,
        frameUrl: "https://authentication.cardinalcommerce.com/challenge",
        frameCount: 2,
        redactedCount: 0,
      }),
    } as unknown as BrowserController;
    const started = await startHarnessProvisionSession({ serviceUrl: url, browser });
    const client = await connectedClient();

    try {
      await client.callTool({
        name: "operate_screenshot",
        arguments: {
          session_id: started.session_id,
          frame_url_contains: "cardinalcommerce.com",
          full_page: true,
        },
      });
      expect(
        (browser.screenshotForOperator as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
      ).toEqual({
        frameUrlContains: "cardinalcommerce.com",
        fullPage: true,
        extraRedactionSelectors: ["#otp-code"],
      });
    } finally {
      await client.close();
      await closeAllProvisionSessions();
    }
  });

  it("aborts the capture when the sealed-field extraction itself fails", async () => {
    const url = "https://operator-screenshot.test/checkout";
    let failExtraction = false;
    const browser = {
      goto: vi.fn().mockResolvedValue(undefined),
      recoverActivePage: vi.fn(),
      extractInteractiveElements: vi
        .fn()
        .mockImplementation(() =>
          failExtraction
            ? Promise.reject(new Error("execution context destroyed"))
            : Promise.resolve([]),
        ),
      extractVisibleText: vi.fn().mockResolvedValue("Checkout page"),
      currentUrl: vi.fn().mockReturnValue(url),
      readCheckoutSummary: vi.fn().mockRejectedValue(new Error("no checkout total")),
      close: vi.fn().mockResolvedValue(undefined),
      screenshotForOperator: vi.fn().mockResolvedValue({
        base64: TINY_JPEG_BASE64,
        frameUrl: null,
        frameCount: 1,
        redactedCount: 0,
      }),
    } as unknown as BrowserController;
    const started = await startHarnessProvisionSession({ serviceUrl: url, browser });
    const client = await connectedClient();

    try {
      failExtraction = true;
      const result = await client.callTool({
        name: "operate_screenshot",
        arguments: { session_id: started.session_id },
      });
      expect(result.isError).toBe(true);
      expect(browser.screenshotForOperator).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await closeAllProvisionSessions();
    }
  });
});
