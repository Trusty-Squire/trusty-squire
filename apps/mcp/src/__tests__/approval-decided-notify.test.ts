import { createServer } from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ApiClient } from "../api-client.js";
import { OperatorBroker } from "../bot/broker/operator.js";
import { listenSharedMcp } from "../bot/broker/mcp-socket.js";
import type { SessionGuard } from "../session-guard.js";
import type { SessionData } from "../session.js";
import { ApprovalDecidedNotifier, pendingApprovals } from "../approval-decided-notifier.js";

type Frame = {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: {
    structuredContent?: Record<string, unknown>;
  };
  error?: unknown;
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

it("recognizes every pending approval result shape, including a drive handoff", () => {
  const expires_at = new Date(Date.now() + 60_000).toISOString();
  const pending = { status: "approval_pending", approval_id: "approval_1", expires_at };
  for (const [tool, kind] of [
    ["inject_card", "payment"],
    ["fetch_credential", "credential_fetch"],
    ["edit_credential", "credential_mutation"],
    ["delete_credential", "credential_mutation"],
    ["edit_payment_card", "card_mutation"],
  ]) {
    expect(pendingApprovals(tool!, pending)).toEqual([
      {
        id: "approval_1",
        kind,
        expiresAt: Date.parse(expires_at),
      },
    ]);
  }
  expect(
    pendingApprovals("operate_drive", {
      status: "pending_approval",
      payment: pending,
    }),
  ).toEqual([{ id: "approval_1", kind: "payment", expiresAt: Date.parse(expires_at) }]);
  expect(
    pendingApprovals("fetch_credential", {
      ...pending,
      status: "credential_fetched",
    }),
  ).toEqual([]);
});

it("keeps one non-consuming payment wait outstanding and reissues after a held pending result", async () => {
  let releaseFirst!: (value: { status: string }) => void;
  const first = new Promise<{ status: string }>((resolve) => {
    releaseFirst = resolve;
  });
  const getPaymentApproval = vi
    .fn()
    .mockImplementationOnce(async () => await first)
    .mockResolvedValueOnce({ status: "approved" });
  const notification = vi.fn(async (_message: unknown) => {});
  const notifier = new ApprovalDecidedNotifier({ notification } as unknown as Server);
  notifier.watch(
    "inject_card",
    {
      status: "approval_pending",
      approval_id: "pay_1",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
    { getPaymentApproval } as unknown as ApiClient,
  );
  await vi.waitFor(() => expect(getPaymentApproval).toHaveBeenCalledTimes(1));
  expect(getPaymentApproval.mock.calls[0]?.slice(0, 3)).toEqual([
    "pay_1",
    "wait-decision-peek",
    15_000,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(getPaymentApproval).toHaveBeenCalledTimes(1);
  releaseFirst({ status: "pending" });
  await vi.waitFor(() => expect(getPaymentApproval).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(notification).toHaveBeenCalledTimes(1));
  expect(notification.mock.calls[0]?.[0]).toMatchObject({
    method: "notifications/approval_decided",
    params: { approval_id: "pay_1", status: "approved" },
  });
  notifier.close();
});

async function relay(root: string, identity: string) {
  const bin = fileURLToPath(new URL("../bin.ts", import.meta.url));
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ["--import", "tsx", bin, "server"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        TRUSTY_SQUIRE_PROFILE_DIR: join(root, ".trusty-squire", "chrome-profile"),
        TRUSTY_SQUIRE_AGENT_IDENTITY: identity,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  cleanup.push(async () => {
    child.kill();
  });
  const frames: Frame[] = [];
  let buffered = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      frames.push(JSON.parse(buffered.slice(0, end)) as Frame);
      buffered = buffered.slice(end + 1);
    }
  });
  let nextId = 1;
  const call = async (method: string, params: Record<string, unknown>) => {
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await vi.waitFor(() => expect(frames.find((frame) => frame.id === id)).toBeDefined(), {
      timeout: 5_000,
    });
    const frame = frames.find((item) => item.id === id)!;
    expect(frame.error).toBeUndefined();
    return frame.result!;
  };
  await call("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: identity, version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { frames, call, child };
}

it("sends each approved or denied decision once on the originating stdio relay only", async () => {
  const root = await mkdtemp(join(process.cwd(), ".approval-notify-"));
  cleanup.push(async () => await rm(root, { recursive: true, force: true }));
  const approvals = new Map<string, "pending" | "approved" | "denied">();
  let created = 0;
  const expiry = new Date(Date.now() + 60_000).toISOString();
  const statusReads = new Map<string, number>();
  const body = (id: string) => ({
    approval_id: id,
    approval_url: `https://example.test/approve/${id}`,
    status: approvals.get(id),
    credential: { reference: "credential_1", service: "Example", name: "Key" },
    field: null,
    field_names: ["key"],
    expires_at: expiry,
  });
  const api = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    let data: unknown;
    if (request.method === "POST" && path === "/v1/vault/fetch-approvals") {
      const id = `fetch_${++created}`;
      approvals.set(id, "pending");
      data = body(id);
    } else {
      const id = path.match(/^\/v1\/vault\/fetch-approvals\/(fetch_\d+)(?:\/ceremony)?$/)?.[1];
      if (id && path.endsWith("/ceremony")) {
        statusReads.set(id, (statusReads.get(id) ?? 0) + 1);
        if (url.searchParams.get("wait_for_decision") === "1") {
          const deadline = Date.now() + Number(url.searchParams.get("wait_ms"));
          while (approvals.get(id) === "pending" && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
      }
      data = id && approvals.has(id) ? body(id) : { error: "not_found" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => await new Promise<void>((resolve) => api.close(() => resolve())));
  const address = api.address();
  if (address === null || typeof address === "string") throw new Error("no API address");
  const guard = (): SessionGuard => ({
    bind: async () =>
      ({
        account_id: "acct",
        agent_session_token: "token",
        api_base_url: `http://127.0.0.1:${address.port}`,
      }) as SessionData,
    inspect: async () => ({ problem: null }),
    boundAccountId: () => "acct",
  });
  const listener = await listenSharedMcp(
    new OperatorBroker({ registryBaseUrl: "http://unused.test" }),
    join(root, ".trusty-squire", "mcp.sock"),
    guard,
  );
  cleanup.push(async () => await listener.close());
  const [alice, bob] = await Promise.all([relay(root, "alice"), relay(root, "bob")]);
  const start = (client: typeof alice) =>
    client.call("tools/call", {
      name: "fetch_credential",
      arguments: { reference: "credential_1" },
    });
  const [aliceResult, bobResult] = await Promise.all([start(alice), start(bob)]);
  const aliceId = String(aliceResult.structuredContent?.approval_id);
  const bobId = String(bobResult.structuredContent?.approval_id);
  expect(new Set([aliceId, bobId])).toEqual(new Set(["fetch_1", "fetch_2"]));
  // Repeated pending results for the same approval must not add another watch.
  await alice.call("tools/call", { name: "fetch_credential", arguments: { approval_id: aliceId } });
  await bob.call("tools/call", { name: "fetch_credential", arguments: { approval_id: aliceId } });
  await new Promise((resolve) => setTimeout(resolve, 3_300));
  expect(statusReads.get(aliceId)).toBeLessThanOrEqual(2);
  expect(statusReads.get(bobId)).toBeLessThanOrEqual(2);
  approvals.set(aliceId, "approved");
  await vi.waitFor(
    () =>
      expect(
        alice.frames.filter((frame) => frame.method === "notifications/approval_decided"),
      ).toEqual([
        {
          jsonrpc: "2.0",
          method: "notifications/approval_decided",
          params: { approval_id: aliceId, status: "approved" },
        },
      ]),
    { timeout: 5_000 },
  );
  expect(bob.frames.filter((frame) => frame.method === "notifications/approval_decided")).toEqual(
    [],
  );
  approvals.set(bobId, "denied");
  await vi.waitFor(
    () =>
      expect(
        bob.frames.filter((frame) => frame.method === "notifications/approval_decided"),
      ).toEqual([
        {
          jsonrpc: "2.0",
          method: "notifications/approval_decided",
          params: { approval_id: bobId, status: "denied" },
        },
      ]),
    { timeout: 5_000 },
  );
  expect(
    alice.frames.filter((frame) => frame.method === "notifications/approval_decided"),
  ).toHaveLength(1);
}, 15_000);
