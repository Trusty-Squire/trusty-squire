import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchJournal } from "../../bot/broker/dispatch-journal.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ProvisionSession from "../../bot/provision-session.js";
import type { ApiClient } from "../../api-client.js";
import {
  withOperatorRequestContext,
  markOperatorMutationDispatchAttempted,
} from "../../bot/request-cancellation.js";

const state = vi.hoisted(() => ({ action: vi.fn(), capture: vi.fn() }));
vi.mock("../../bot/provision-session.js", async (original) => ({
  ...(await original<typeof ProvisionSession>()),
  act: state.action,
  captureCredentialSource: state.capture,
  observedHostsForSession: () => ["example.test"],
}));
import { operateClickTool, provisionExtractTool } from "../provision-drive.js";
const secret = ["fixture", "private", "credential"].join("-");
const capture = {
  store: { service: "Example", label: "fresh" },
  source: { role: "textbox", name: "API key", container: { role: "dialog" } },
};
let root: string;
let journal: DispatchJournal;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "capture-review-"));
  journal = new DispatchJournal(join(root, "journal.jsonl"));
  state.action.mockReset();
  state.capture.mockReset();
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    return { dom: secret };
  });
  state.capture.mockResolvedValue({ candidate_count: 1, value: secret });
});
afterEach(async () => await rm(root, { recursive: true, force: true }));
function api(store: ApiClient["storeCredential"]): ApiClient {
  return { storeCredential: store } as ApiClient;
}
const stored = {
  reference: "vault://account/capture/one",
  service: "Example",
  label: "fresh",
  field_names: ["value"],
  allowed_hosts: ["example.test"],
  created_at: "2026-09-10T00:00:00Z",
  auth_strategy: null,
  signin_url: null,
  login_hosts: [],
  updated: false,
};
async function click(client: ApiClient) {
  return await withOperatorRequestContext(
    new AbortController().signal,
    async () =>
      await operateClickTool.handler(
        operateClickTool.inputSchema.parse({ session_id: "session", ref: "@create", capture }),
        client,
      ),
    undefined,
    {
      operationId: "create-one",
      onCapture: async (evidence, recovery) => {
        if (state.action.mock.calls.length === 0)
          expect(await journal.hasCaptureWrite("lineage", "session", evidence.write_id)).toBe(
            false,
          );
        await journal.recordCapture("lineage", "session", "create-one", evidence, recovery);
      },
    },
  );
}
describe("explicit mutation capture", () => {
  it("preserves the screenshot dispatch receipt alongside successful capture metadata", async () => {
    const store = vi.fn().mockResolvedValue(stored);
    const screenshot = { screenshot_id: "12345678-1234-4234-8234-123456789abc", x: 10, y: 20 };
    const result = await withOperatorRequestContext(new AbortController().signal, () =>
      operateClickTool.handler(
        operateClickTool.inputSchema.parse({ session_id: "session", screenshot, capture }),
        api(store),
      ),
    );
    expect(result).toMatchObject({
      mutation: "dispatched",
      stored: true,
      stored_credential: { reference: stored.reference },
      screenshot_click: {
        dispatch: "dispatched",
        outcome: "unknown",
        retry_policy: "observe_before_new_action",
      },
    });
    expect(state.action).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("executes once and returns only storage metadata", async () => {
    const store = vi.fn().mockResolvedValue(stored);
    const result = await click(api(store));
    expect(state.action).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({ value: secret, write_id: "create-one" }),
    );
    expect(result).toMatchObject({
      mutation: "dispatched",
      stored: true,
      stored_credential: { reference: stored.reference },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("does not guess when the source is ambiguous", async () => {
    state.capture.mockResolvedValue({ candidate_count: 2 });
    const store = vi.fn();
    expect(await click(api(store))).toMatchObject({
      stored: false,
      error: "capture_ambiguous",
      candidate_count: 2,
      write_id: "create-one",
    });
    await journal.acknowledge("lineage", "create-one");
    expect(await journal.hasOutstanding("session")).toBe(true);
    await expect(
      journal.recordCapture(
        "lineage",
        "session",
        "new",
        {
          write_id: "new",
          stored: false,
          storage: "unknown",
        },
        false,
      ),
    ).rejects.toThrow("original capture write identity");
    expect(store).not.toHaveBeenCalled();
    expect(state.action).toHaveBeenCalledOnce();
  });
  it("retries extraction with the original write identity without a second create", async () => {
    const store = vi.fn().mockRejectedValueOnce(new Error(secret)).mockResolvedValue(stored);
    const first = await click(api(store));
    expect(first).toMatchObject({
      stored: false,
      storage: "unknown",
      write_id: "create-one",
      retry: "extract_only",
    });
    expect(JSON.stringify(first)).not.toContain(secret);
    const retry = await withOperatorRequestContext(
      new AbortController().signal,
      async () =>
        await provisionExtractTool.handler(
          provisionExtractTool.inputSchema.parse({
            session_id: "session",
            capture: { ...capture, write_id: "create-one" },
          }),
          api(store),
        ),
      undefined,
      {
        operationId: "extract-retry",
        onCapture: async (evidence, recovery) =>
          await journal.recordCapture("lineage", "session", "extract-retry", evidence, recovery),
      },
    );
    expect(retry).toMatchObject({ stored: true });
    expect(state.action).toHaveBeenCalledOnce();
    expect(store.mock.calls.map(([input]) => input.write_id)).toEqual(["create-one", "create-one"]);
  });
  it("recovers a zero-match textbox capture through an explicit plain-text source", async () => {
    state.capture.mockResolvedValueOnce({ candidate_count: 0 });
    const store = vi.fn().mockResolvedValue(stored);
    expect(await click(api(store))).toMatchObject({
      stored: false,
      candidate_count: 0,
      write_id: "create-one",
    });
    expect(store).not.toHaveBeenCalled();
    const source = {
      selector: 'label:text-is("API token") + div div:not(:has(*))',
      container: { role: "dialog" },
    };
    const result = await withOperatorRequestContext(
      new AbortController().signal,
      async () =>
        await provisionExtractTool.handler(
          provisionExtractTool.inputSchema.parse({
            session_id: "session",
            capture: { ...capture, source, write_id: "create-one" },
          }),
          api(store),
        ),
      undefined,
      {
        operationId: "extract-retry",
        onCapture: async (evidence, recovery) =>
          await journal.recordCapture("lineage", "session", "extract-retry", evidence, recovery),
      },
    );
    expect(state.capture).toHaveBeenLastCalledWith("session", source);
    expect(state.action).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({ value: secret, write_id: "create-one" }),
    );
    expect(result).toMatchObject({ stored: true, write_id: "create-one" });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("does not capture after a refused action or advertise a replay on mutation inputs", async () => {
    state.action.mockResolvedValue({ status: "stale_ref" });
    const store = vi.fn();
    expect(await click(api(store))).toMatchObject({
      stored: false,
      error: "capture_action_unresolved",
      status: "stale_ref",
      action_result: { status: "stale_ref" },
      mutation: "not_dispatched",
      retry: "action",
    });
    expect(state.capture).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    await expect(
      operateClickTool.handler(
        operateClickTool.inputSchema.parse({
          session_id: "session",
          ref: "@create",
          capture: { ...capture, write_id: "old" },
        }),
        api(store),
      ),
    ).rejects.toThrow("extraction-only recovery");
  });
  it("journals unresolved action identity and preserves human outcome booleans", async () => {
    state.action.mockImplementation(async () => {
      expect(await journal.hasCaptureWrite("lineage", "session", "create-one")).toBe(true);
      await markOperatorMutationDispatchAttempted();
      return { needs_user: true, acknowledged: false };
    });
    expect(await click(api(vi.fn()))).toMatchObject({
      write_id: "create-one",
      needs_user: true,
      acknowledged: false,
      action_result: { needs_user: true, acknowledged: false },
      retry: "extract_only",
    });
    await journal.acknowledge("lineage", "create-one");
    expect(await journal.hasOutstanding("session")).toBe(true);
    await expect(
      journal.recordCapture(
        "lineage",
        "session",
        "recovery",
        {
          write_id: "create-one",
          binding: "other-service",
          stored: false,
          storage: "unknown",
        },
        true,
      ),
    ).rejects.toThrow("original service-bound");
    await expect(
      provisionExtractTool.handler(
        provisionExtractTool.inputSchema.parse({
          session_id: "session",
          capture: { ...capture, write_id: "guessed" },
        }),
        api(vi.fn()),
      ),
    ).rejects.toThrow("recorded write identity");
  });
  it("leaves ordinary action results unredacted", async () => {
    expect(await operateClickTool.handler({ session_id: "session", ref: "@create" }, null)).toEqual(
      { dom: secret },
    );
    expect(state.capture).not.toHaveBeenCalled();
  });
});
