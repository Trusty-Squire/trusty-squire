import { beforeEach, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import type * as sessionLifecycle from "../bot/session/lifecycle.js";
import type * as provisionSession from "../bot/provision-session.js";
import { runOperateDrive } from "../bot/operate-drive.js";
import { findTool } from "../tools/index.js";

const operateDriveTool = findTool("operate_drive")!;

vi.mock("../bot/operate-drive.js", () => ({ runOperateDrive: vi.fn() }));
vi.mock("../bot/session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof sessionLifecycle>()),
  sessionForCall: () => undefined,
}));
vi.mock("../bot/provision-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof provisionSession>()),
  observedHostsForSession: () => ["app.example.test"],
}));

beforeEach(() => vi.clearAllMocks());

it("preserves the registered storage destination through parsing and vault persistence", async () => {
  const storeCredential = vi.fn(async () => ({
    reference: "vault:example:test",
    service: "example",
    label: "bootstrap",
    field_names: ["api_key"],
    allowed_hosts: ["api.example.test"],
    updated: false,
  }));
  vi.mocked(runOperateDrive).mockImplementation(async (_args, _api, context) => {
    expect(
      await context?.persistCredentials?.({
        session_id: "session",
        url: "https://app.example.test/keys",
        credentials: { api_key: "one-time-key" },
      }),
    ).toBe(true);
    return { status: "complete" } as Awaited<ReturnType<typeof runOperateDrive>>;
  });
  const args = operateDriveTool.inputSchema.parse({
    session_id: "session",
    goal: "Get a key and store it",
    store: {
      service: "example",
      label: "bootstrap",
      api_hosts: ["api.example.test"],
      auth_shape: "header:x-api-key",
      env_var_suggestion: "EXAMPLE_KEY",
      type: "api_key",
    },
  });
  await operateDriveTool.handler(args, { storeCredential } as unknown as ApiClient);
  expect(storeCredential).toHaveBeenCalledWith({
    service: "example",
    label: "bootstrap",
    value: "one-time-key",
    auth_shape: "header:x-api-key",
    env_var_suggestion: "EXAMPLE_KEY",
    type: "api_key",
    observed_hosts: ["api.example.test", "app.example.test", "*.example.test"],
  });
});

it("supplies no automatic persistence without a destination", async () => {
  vi.mocked(runOperateDrive).mockImplementation(async (_args, _api, context) => {
    expect(context?.persistCredentials).toBeUndefined();
    return { status: "budget" } as Awaited<ReturnType<typeof runOperateDrive>>;
  });
  await operateDriveTool.handler(
    operateDriveTool.inputSchema.parse({ session_id: "session", goal: "Browse" }),
    {} as ApiClient,
  );
});

it.each([{ session_id: "session" }, { url: "https://app.example.test/keys" }])(
  "preserves store for the registered drive entry %j",
  (entry) => {
    const store = { service: "example", label: "bootstrap" };
    const parsed = operateDriveTool.inputSchema.safeParse({
      ...entry,
      goal: "Get a key and store it",
      store,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.store).toEqual(store);
  },
);

it.each([
  { label: "bootstrap" },
  { service: "" },
  { service: "example", auth_shape: "invalid" },
  { service: "example", api_hosts: "api.example.test" },
])("rejects invalid store destinations at the registered boundary: %j", (store) => {
  expect(
    operateDriveTool.inputSchema.safeParse({
      session_id: "session",
      goal: "Get a key and store it",
      store,
    }).success,
  ).toBe(false);
});
