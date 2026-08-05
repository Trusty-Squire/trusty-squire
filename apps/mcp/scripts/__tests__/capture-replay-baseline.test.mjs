import { describe, expect, it } from "vitest";
import {
  CAPTURE_POLICY,
  buildCaptureEnvironment,
  buildCodexArguments,
  endStatesMatch,
  isAllowedTopLevelUrl,
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

function browserEvent(tool, currentUrl, snapshot) {
  return {
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "replay_browser",
      tool,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, current_url: currentUrl, snapshot }) },
        ],
      },
    },
  };
}

describe("replay baseline capture trust boundary", () => {
  it("requires exact totals and browser-grounded checkout evidence", () => {
    const endState = task.expected_end_state;
    const events = [
      browserEvent(
        "browser_open",
        "https://whitejade.xyz/cart/53575613546607:1",
        'RootWebArea "Cart" url="https://whitejade.xyz/cart/53575613546607:1" The Glow Serum $68.00',
      ),
      browserEvent(
        "browser_snapshot",
        "https://whitejade.xyz/checkouts/cn/session",
        'RootWebArea "Checkout" url="https://whitejade.xyz/checkouts/cn/session" The Glow Serum Quantity 1 Total $76.00',
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

  it("runs Codex read-only with no shell and a minimal environment", () => {
    const args = buildCodexArguments({
      model: "test-model",
      mcpServerPath: "/repo/browser.mjs",
      browserConfig: {
        chrome_entry: "/repo/chrome.mjs",
        session: "test",
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
