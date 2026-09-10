import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import {
  withOperatorRequestContext,
  markOperatorMutationDispatchAttempted,
} from "../../bot/request-cancellation.js";

const state = vi.hoisted(() => ({ action: vi.fn(), capture: vi.fn() }));
vi.mock("../../bot/provision-session.js", async (original) => ({
  ...(await original<typeof import("../../bot/provision-session.js")>()),
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
beforeEach(() => {
  state.action.mockReset();
  state.capture.mockReset();
  state.action.mockImplementation(async () => {
    await markOperatorMutationDispatchAttempted();
    return { dom: secret };
  });
  state.capture.mockResolvedValue({ candidate_count: 1, value: secret });
});
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
    { operationId: "create-one" },
  );
}
describe("explicit mutation capture", () => {
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
    });
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
    const retry = await provisionExtractTool.handler(
      provisionExtractTool.inputSchema.parse({
        session_id: "session",
        capture: { ...capture, write_id: "create-one" },
      }),
      api(store),
    );
    expect(retry).toMatchObject({ stored: true });
    expect(state.action).toHaveBeenCalledOnce();
    expect(store.mock.calls.map(([input]) => input.write_id)).toEqual(["create-one", "create-one"]);
  });
  it("does not capture after a refused action or advertise a replay on mutation inputs", async () => {
    state.action.mockResolvedValue({ status: "stale_ref" });
    const store = vi.fn();
    expect(await click(api(store))).toMatchObject({
      stored: false,
      error: "capture_action_unresolved",
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
  it("leaves ordinary action results unredacted", async () => {
    expect(await operateClickTool.handler({ session_id: "session", ref: "@create" }, null)).toEqual(
      { dom: secret },
    );
    expect(state.capture).not.toHaveBeenCalled();
  });
});
