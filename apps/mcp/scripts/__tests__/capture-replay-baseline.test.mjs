import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPTURE_POLICY,
  buildGroundingDiagnostic,
  buildCaptureEnvironment,
  buildCodexArguments,
  endStatesMatch,
  isAllowedTopLevelUrl,
  sanitizeReplayHar,
  shouldBlockTopLevelNavigation,
  validateGroundedCapture,
} from "../replay-capture-support.mjs";

const task = {
  task_id: "whitejade-purchase-r0",
  bucket: "repeat",
  params: { product_variant_id: "53575613546607" },
  entry_url: "https://whitejade.xyz/products/the-glow-serum",
  expected_end_state: {
    line_items: [{ title_contains: "The Glow Serum", qty: 1 }],
    total_cents: 7600,
    reached: "checkout_review",
  },
};

function browserEvent(tool, currentUrl, snapshot, checkoutTotals = []) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "replay_browser",
      tool,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              current_url: currentUrl,
              snapshot,
              checkout_totals: checkoutTotals,
            }),
          },
        ],
      },
    },
  };
}

describe("replay baseline capture trust boundary", () => {
  it("keeps checked-in replay artifacts free of session material", () => {
    const corpus = resolve(import.meta.dirname, "../../../../corpus/shopping");
    for (const taskId of [
      "whitejade-purchase-r0",
      "whitejade-purchase-r1",
      "whitejade-purchase-r2",
      "whitejade-purchase-r3",
    ]) {
      const har = readFileSync(resolve(corpus, `${taskId}.har`), "utf8");
      expect(har).not.toMatch(/shop_pay_token|"name":"(?:set-)?cookie"/i);
      expect(har).not.toMatch(
        /https:\/\/shop\.app\/checkouts?\/(?!redacted(?:["?/#\\]|$))/i,
      );
      expect(har).not.toMatch(
        /https:\/\/whitejade\.xyz\/checkouts\/(?!redacted(?:["?/#\\]|$))/i,
      );
      expect(har).not.toMatch(/(?:ur_verify|tracking_unique|tracking_visit)=/i);
    }
    expect(
      existsSync(resolve(corpus, "traces/debug/whitejade-purchase-r0.grounding-failure.json")),
    ).toBe(false);
  });

  it("removes session material from persisted HARs", () => {
    const har = {
      log: {
        entries: [
          {
            request: {
              url: "https://whitejade.xyz/cart?shop_pay_token=secret",
              headers: [
                { name: "Cookie", value: "session=secret" },
                { name: "Accept", value: "text/html" },
              ],
              cookies: [{ name: "session", value: "secret" }],
              queryString: [{ name: "shop_pay_token", value: "secret" }],
            },
            response: {
              headers: [
                { name: "Set-Cookie", value: "session=secret" },
                {
                  name: "Location",
                  value: "https://whitejade.xyz/checkouts/cn/session/en-us?_r=secret",
                },
              ],
              cookies: [{ name: "session", value: "secret" }],
              redirectURL: "https://whitejade.xyz/checkouts/cn/session/en-us?_r=secret",
              content: {
                text: "redirect=https://whitejade.xyz/checkouts/cn/session/en-us?_su_rec=secret",
              },
            },
          },
        ],
      },
    };
    const sanitized = sanitizeReplayHar(har);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toMatch(/set-cookie|shop_pay_token/i);
    expect(sanitized.log.entries[0].response.redirectURL).toBe(
      "https://whitejade.xyz/checkouts/redacted",
    );
  });

  it("drops redirecting cart posts with Shop checkout sessions", () => {
    const redirect =
      "https://shop.app/checkout/73057009775/cn/session/en-us/shoppay?" +
      "tracking_unique=secret&ur_back_url=https%3A%2F%2Fwhitejade.xyz%2Fcheckouts%2Fcn%2Fsession%3F_r%3Dsecret&ur_verify=secret";
    const har = {
      log: {
        entries: [
          {
            request: { method: "POST", url: "https://whitejade.xyz/cart" },
            response: {
              status: 302,
              headers: [{ name: "Location", value: redirect }],
              redirectURL: redirect,
            },
          },
          {
            request: { method: "GET", url: "https://whitejade.xyz/cart.js" },
            response: { status: 200, headers: [], redirectURL: "" },
          },
        ],
      },
    };
    const sanitized = sanitizeReplayHar(har);
    expect(sanitized.log.entries).toHaveLength(1);
    expect(JSON.stringify(sanitized)).not.toContain("secret");
  });

  it("hashes raw grounding evidence and redacts checkout URLs", () => {
    const diagnostic = buildGroundingDiagnostic(
      task,
      [
        {
          tool: "browser_snapshot",
          current_url: "https://whitejade.xyz/checkouts/cn/session/en-us?_r=secret",
          snapshot: "The Glow Serum value=private",
          checkout_totals: [{ label: "Total", amount: "$76.00" }],
        },
      ],
      '{"private":"message"}',
      "grounding failed",
    );
    expect(diagnostic.final_agent_message).toBeUndefined();
    expect(diagnostic.observations[0].snapshot).toBeUndefined();
    expect(diagnostic.observations[0].url).toBe("https://whitejade.xyz/checkouts/redacted");
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|session|secret/);
  });

  it("requires exact totals and browser-grounded checkout evidence", () => {
    const endState = task.expected_end_state;
    const events = [
      browserEvent(
        "browser_open",
        task.entry_url,
        `RootWebArea "Product" url="${task.entry_url}" The Glow Serum $68.00`,
      ),
      browserEvent(
        "browser_snapshot",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" The Glow Serum Quantity 1 Total $76.00 Payment controls: {"value":"replay-eval+whitejade-purchase-r0@trustysquire.ai"} {"value":"123 Test Street"} {"value":"10001"}',
        [{ label: "Total", amount: "$76.00" }],
      ),
    ];
    expect(validateGroundedCapture(events, endState, task)).toMatchObject({
      browser_observations: 2,
      capture_policy: CAPTURE_POLICY,
      evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(endStatesMatch({ ...endState, total_cents: endState.total_cents + 100 }, endState)).toBe(
      false,
    );
  });

  it("rejects prompt-echoed results without constrained browser calls", () => {
    expect(() => validateGroundedCapture([], task.expected_end_state, task)).toThrow(
      "did not begin with the constrained browser",
    );
  });

  it("rejects checkout evidence with neither item nor settled total", () => {
    const splitTask = {
      ...task,
      task_id: "whitejade-purchase-r1",
      expected_end_state: {
        line_items: [{ title_contains: "The Recovery Crème", qty: 1 }],
        total_cents: 8800,
        reached: "checkout_review",
      },
    };
    const events = [
      browserEvent(
        "browser_open",
        "https://whitejade.xyz/cart/variant:1",
        'RootWebArea "Cart" url="https://whitejade.xyz/cart/variant:1" The Recovery Crème $88.00',
      ),
      browserEvent(
        "browser_snapshot",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" Payment controls: {"value":"replay-eval+whitejade-purchase-r1@trustysquire.ai"} {"value":"123 Test Street"} {"value":"10001"}',
      ),
    ];
    expect(() => validateGroundedCapture(events, splitTask.expected_end_state, splitTask)).toThrow(
      "checkout review sequence did not prove the expected end state",
    );
  });

  it("rejects a matching line-item price when the labeled total differs", () => {
    const pricedTask = {
      ...task,
      task_id: "whitejade-purchase-r1",
      expected_end_state: {
        line_items: [{ title_contains: "The Recovery Crème", qty: 1 }],
        total_cents: 8800,
        reached: "checkout_review",
      },
    };
    const events = [
      browserEvent(
        "browser_open",
        "https://whitejade.xyz/cart/variant:1",
        'RootWebArea "Cart" url="https://whitejade.xyz/cart/variant:1" The Recovery Crème $88.00',
      ),
      browserEvent(
        "browser_snapshot",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" The Recovery Crème $88.00 Total $99.00 Payment controls: {"value":"replay-eval+whitejade-purchase-r1@trustysquire.ai"} {"value":"123 Test Street"} {"value":"10001"}',
        [{ label: "Total", amount: "$99.00" }],
      ),
    ];
    expect(() =>
      validateGroundedCapture(events, pricedTask.expected_end_state, pricedTask),
    ).toThrow("checkout review sequence did not prove the expected end state");
  });

  it("accepts checkout item evidence before the final shipping-settled labeled total", () => {
    const events = [
      browserEvent("browser_open", task.entry_url, `RootWebArea "Product" url="${task.entry_url}" The Glow Serum $68.00`),
      browserEvent(
        "browser_snapshot",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" The Glow Serum Payment controls: {"value":"replay-eval+whitejade-purchase-r0@trustysquire.ai"} {"value":"123 Test Street"} {"value":"10001"}',
        [{ label: "Total", amount: "$68.00" }],
      ),
      browserEvent(
        "browser_wait",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" Payment controls: {"value":"replay-eval+whitejade-purchase-r0@trustysquire.ai"} {"value":"123 Test Street"} {"value":"10001"}',
        [{ label: "Total", amount: "$76.00" }],
      ),
    ];
    expect(validateGroundedCapture(events, task.expected_end_state, task)).toMatchObject({
      browser_observations: 3,
    });
  });

  it("rejects evidence from outside the task domain", () => {
    const events = [
      browserEvent(
        "browser_open",
        "https://evil.example/cart",
        'RootWebArea "Cart" url="https://evil.example/cart" The Glow Serum $76.00',
      ),
    ];
    expect(() => validateGroundedCapture(events, task.expected_end_state, task)).toThrow(
      "left the task domain",
    );
    expect(isAllowedTopLevelUrl("https://whitejade.xyz/checkouts/1", ["whitejade.xyz"])).toBe(true);
    expect(isAllowedTopLevelUrl("http://whitejade.xyz/checkouts/1", ["whitejade.xyz"])).toBe(false);
    expect(isAllowedTopLevelUrl("https://evil.example/checkouts/1", ["whitejade.xyz"])).toBe(false);
  });

  it("accepts exact whole-dollar prices observed without decimals", () => {
    const novelTask = {
      task_id: "allbirds-purchase-n0",
      bucket: "novel",
      params: {},
      entry_url: "https://www.allbirds.com/products/mens-tree-runner-nz-medium-grey",
      expected_end_state: {
        line_items: [{ title_contains: "Men's Tree Runner NZ", qty: 1 }],
        total_cents: 10000,
        reached: "product_page",
      },
    };
    const events = [
      browserEvent(
        "browser_open",
        novelTask.entry_url,
        `RootWebArea "Men's Tree Runner NZ" url="${novelTask.entry_url}" Men's Tree Runner NZ $100`,
      ),
    ];
    expect(validateGroundedCapture(events, novelTask.expected_end_state, novelTask)).toMatchObject({
      browser_observations: 1,
    });
  });

  it("blocks off-domain main-frame requests before navigation", () => {
    const allowedHosts = ["whitejade.xyz"];
    expect(
      shouldBlockTopLevelNavigation(
        {
          url: "https://evil.example/collect",
          isNavigationRequest: true,
          isMainFrame: true,
        },
        allowedHosts,
      ),
    ).toBe(true);
    expect(
      shouldBlockTopLevelNavigation(
        {
          url: "https://cdn.example/asset.js",
          isNavigationRequest: false,
          isMainFrame: false,
        },
        allowedHosts,
      ),
    ).toBe(false);
    expect(
      shouldBlockTopLevelNavigation(
        {
          url: "https://evil.example/frame",
          isNavigationRequest: true,
          isMainFrame: false,
        },
        allowedHosts,
      ),
    ).toBe(false);
    expect(
      shouldBlockTopLevelNavigation(
        {
          url: "https://whitejade.xyz/checkouts/1",
          isNavigationRequest: true,
          isMainFrame: true,
        },
        allowedHosts,
      ),
    ).toBe(false);
  });

  it("runs Codex read-only with no shell and a minimal environment", () => {
    const args = buildCodexArguments({
      model: "test-model",
      mcpServerPath: "/repo/browser.mjs",
      browserConfig: {
        start_url: "https://whitejade.xyz",
        allowed_hosts: ["whitejade.xyz"],
      },
      disabledMcpServers: ["untrusted_server"],
    });
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
    expect(args).toContain("shell_tool");
    expect(args.join(" ")).toContain("mcp_servers.replay_browser.command");
    expect(args.join(" ")).toContain(
      'mcp_servers.replay_browser.default_tools_approval_mode="approve"',
    );
    expect(args.join(" ")).toContain("browser_select");
    expect(args.join(" ")).toContain('approval_policy="never"');
    expect(args.join(" ")).toContain("mcp_servers.untrusted_server.enabled=false");

    const environment = buildCaptureEnvironment({
      CODEX_HOME: "/auth",
      OPENAI_API_KEY: "allowed-auth",
      AWS_SECRET_ACCESS_KEY: "must-not-pass",
      GITHUB_TOKEN: "must-not-pass",
    });
    expect(environment).toMatchObject({
      CODEX_HOME: "/auth",
      OPENAI_API_KEY: "allowed-auth",
    });
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
  });
});
