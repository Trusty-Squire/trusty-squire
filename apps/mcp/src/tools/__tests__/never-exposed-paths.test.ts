// The two credential paths that must stay never-exposed after fetch_credential
// landed. fetch_credential is an ADDITION — one narrow, human-approved door —
// not a relaxation of the vault's posture. If either of these ever starts
// handing the agent a raw value on its own authority, the approval gate stops
// being the only way in and the whole design is void.

import { describe, expect, it } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { storedExtractResult } from "../provision-drive.js";
import { useCredentialTool } from "../use-credential.js";
import { fetchCredentialTool } from "../fetch-credential.js";
import { buildToolRegistry } from "../index.js";

const SECRET = "sk-live-this-must-never-leak";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

describe("use_credential is unchanged: the agent still never sees the value", () => {
  it("returns only the upstream response, and sends no secret of its own", async () => {
    let sent: unknown;
    const api = mockApi({
      useCredential: async (input) => {
        sent = input;
        return {
          response: {
            status: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true }),
            truncated: false,
          },
        };
      },
    });
    const res = await useCredentialTool.handler(
      {
        service: "OpenAI",
        http: {
          method: "GET",
          url: "https://api.openai.com/v1/models",
          headers: { authorization: "Bearer ${SECRET}" },
        },
      },
      api,
    );
    // The placeholder crosses the wire, never a value — substitution is the
    // server's job, which is what keeps the secret out of this process.
    expect(JSON.stringify(sent)).toContain("${SECRET}");
    expect(JSON.stringify(sent)).not.toContain(SECRET);
    expect(res).toEqual({
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
        truncated: false,
      },
    });
  });

  it("takes no approval_id and has no resume mode — it never needed one", () => {
    expect(useCredentialTool.inputSchema.safeParse({ service: "X", approval_id: "a" }).success).toBe(
      false,
    );
    expect(Object.keys(useCredentialTool.jsonInputSchema.properties as object)).not.toContain(
      "approval_id",
    );
  });
});

describe("extract { store } is unchanged: vault metadata only", () => {
  it("drops every credential value from the stored result", () => {
    const result = storedExtractResult(
      {
        session_id: "sess_1",
        url: "https://dashboard.example.test/keys",
        credentials: { api_key: SECRET, api_secret: "another-secret" },
        candidate_count: 2,
      },
      {
        reference: "vault://a/b/c",
        service: "Example",
        label: "default",
        field_names: ["api_key", "api_secret"],
        allowed_hosts: ["api.example.test"],
        updated: false,
      },
    );
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("another-secret");
    expect(result).not.toHaveProperty("credentials");
    expect(result.stored_credential.field_names).toEqual(["api_key", "api_secret"]);
  });

  it("still carries a blocked_reason through, so a login wall is not a silent empty", () => {
    const result = storedExtractResult(
      {
        session_id: "sess_1",
        url: "https://dashboard.example.test/login",
        credentials: {},
        candidate_count: 0,
        blocked_reason: "login wall",
      },
      {
        reference: "vault://a/b/c",
        service: "Example",
        label: undefined,
        field_names: [],
        allowed_hosts: [],
        updated: false,
      },
    );
    expect(result.blocked_reason).toBe("login wall");
  });
});

describe("fetch_credential is the only raw-value tool on the surface", () => {
  // The phrase is the contract. Exactly one tool may promise a credential in
  // clear; a second one appearing here means a raw path was added without the
  // approval gate this whole design rests on.
  const RAW_RETURN_PROMISE = "RAW value to you, in clear";

  it("only fetch_credential promises the value in clear", () => {
    const raw = buildToolRegistry({}).filter((tool) =>
      tool.description.includes(RAW_RETURN_PROMISE),
    );
    expect(raw.map((tool) => tool.name)).toEqual([fetchCredentialTool.name]);
  });

  it("and it says so — the phrase is really in there", () => {
    expect(fetchCredentialTool.description).toContain(RAW_RETURN_PROMISE);
  });
});
