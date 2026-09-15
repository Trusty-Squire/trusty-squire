// C2's hit-test readiness race, driven through a stubbed CDP session so the
// retry schedule and the binding's re-arm are exercised without the headed
// Chrome the race only reproduces in. The real-browser half of the screenshot
// click path stays in screenshot-click.test.ts (REAL_BROWSER_FILES).
import { describe, expect, it } from "vitest";
import type { CDPSession, Page } from "playwright";
import { captureBoundScreenshot, clickScreenshot } from "../screenshot-click.js";

const FRAME_ID = "FRAME-MAIN";
const BACKEND_NODE_ID = 42;
const PAGE_URL = "https://shop.example.com/checkout";
const HIT_TEST_MISS = "Protocol error (DOM.getNodeForLocation): No node found at given location";

function pngBase64(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

// The snapshot only has to be self-consistent: captureBoundScreenshot and
// clickScreenshot read it through the same stub, so one painted element is
// enough for the occlusion/node identity checks to agree with themselves.
function snapshotResponse() {
  return {
    strings: [FRAME_ID, "DIV", ""],
    documents: [
      {
        frameId: 0,
        nodes: {
          nodeName: [1],
          nodeType: [1],
          parentIndex: [-1],
          backendNodeId: [BACKEND_NODE_ID],
          nodeValue: [2],
        },
        layout: {
          nodeIndex: [0],
          bounds: [[10, 20, 100, 40]],
          paintOrders: [1],
          styles: [[]],
          text: [2],
        },
      },
    ],
  };
}

type Stub = {
  page: Page;
  clicks: Array<{ x: number; y: number }>;
  hitTestCalls: number;
  hitTestOutcomes: Array<"miss" | "hit" | Error>;
};

function stubPage(): Stub {
  const stub: Stub = {
    clicks: [],
    hitTestCalls: 0,
    hitTestOutcomes: [],
    page: undefined as unknown as Page,
  };
  const send = async (method: string): Promise<unknown> => {
    switch (method) {
      case "Page.getLayoutMetrics":
        return {
          cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
          cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
        };
      case "Page.getFrameTree":
        return { frameTree: { frame: { id: FRAME_ID, url: PAGE_URL } } };
      case "DOMSnapshot.captureSnapshot":
        return snapshotResponse();
      case "DOM.getNodeForLocation": {
        const outcome = stub.hitTestOutcomes[stub.hitTestCalls++] ?? "hit";
        if (outcome === "miss") throw new Error(HIT_TEST_MISS);
        if (outcome !== "hit") throw outcome;
        return { backendNodeId: BACKEND_NODE_ID, frameId: FRAME_ID };
      }
      case "DOM.resolveNode":
        return { object: { objectId: "OBJ-1" } };
      case "Runtime.callFunctionOn":
        return {
          result: { value: { labels: ["Place order"], frameUrl: PAGE_URL, frameOrigin: PAGE_URL } },
        };
      case "Runtime.releaseObject":
        return {};
      default:
        throw new Error(`unstubbed CDP method ${method}`);
    }
  };
  const cdp = { send, detach: async () => undefined } as unknown as CDPSession;
  const mainFrame = { url: () => PAGE_URL, childFrames: () => [] };
  stub.page = {
    context: () => ({ newCDPSession: async () => cdp }),
    frames: () => [mainFrame],
    mainFrame: () => mainFrame,
    mouse: {
      click: async (x: number, y: number) => {
        stub.clicks.push({ x, y });
      },
    },
  } as unknown as Page;
  return stub;
}

async function arm(stub: Stub): Promise<string> {
  const capture = await captureBoundScreenshot(
    stub.page,
    () => PAGE_URL,
    async () => ({ base64: pngBase64(800, 600), rect: { x: 0, y: 0, width: 800, height: 600 } }),
  );
  stub.hitTestCalls = 0;
  const id = capture.clickBinding?.screenshot_id;
  if (id === undefined) throw new Error("binding was not armed");
  return id;
}

describe("screenshot click hit-test readiness race", () => {
  it("dispatches on the same image after transient no-node misses", async () => {
    const stub = stubPage();
    const screenshot_id = await arm(stub);
    stub.hitTestOutcomes = ["miss", "miss", "hit"];

    await expect(
      clickScreenshot(stub.page, { screenshot_id, x: 40, y: 40 }, () => {}),
    ).resolves.toBe("dispatched");
    expect(stub.hitTestCalls).toBe(3);
    expect(stub.clicks).toHaveLength(1);
  });

  it("re-arms the image when every probe resolves no node", async () => {
    const stub = stubPage();
    const screenshot_id = await arm(stub);
    stub.hitTestOutcomes = ["miss", "miss", "miss"];

    await expect(
      clickScreenshot(stub.page, { screenshot_id, x: 40, y: 40 }, () => {}),
    ).rejects.toMatchObject({ code: "invalid_screenshot_point", dispatch: "not_dispatched" });
    expect(stub.clicks).toHaveLength(0);

    // The binding survived: the same image drives a retry with no fresh capture.
    stub.hitTestOutcomes = [];
    await expect(
      clickScreenshot(stub.page, { screenshot_id, x: 40, y: 40 }, () => {}),
    ).resolves.toBe("dispatched");
    expect(stub.clicks).toHaveLength(1);
  });

  it("consumes the image and propagates a protocol failure that is not a miss", async () => {
    const stub = stubPage();
    const screenshot_id = await arm(stub);
    const closed = new Error("Protocol error (DOM.getNodeForLocation): Target closed");
    stub.hitTestOutcomes = [closed];

    await expect(
      clickScreenshot(stub.page, { screenshot_id, x: 40, y: 40 }, () => {}),
    ).rejects.toThrow("Target closed");
    // Retrying a closed target would only burn the probe schedule.
    expect(stub.hitTestCalls).toBe(1);
    expect(stub.clicks).toHaveLength(0);

    // Not a no-node failure, so the image is spent.
    stub.hitTestOutcomes = [];
    await expect(
      clickScreenshot(stub.page, { screenshot_id, x: 40, y: 40 }, () => {}),
    ).rejects.toMatchObject({ code: "stale_screenshot", dispatch: "not_dispatched" });
  });
});
