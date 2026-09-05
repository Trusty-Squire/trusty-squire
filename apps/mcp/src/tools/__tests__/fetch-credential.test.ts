// fetch_credential's client half. The server owns the security boundary; what
// this tool owns is (a) never inventing a value the server did not send, and
// (b) rendering every refusal as a typed result the agent can act on instead of
// an opaque HTTP error it will retry blindly.

import { describe, expect, it } from "vitest";
import { ApiCallError, type ApiClient, type CredentialFetchApproval } from "../../api-client.js";
import { fetchCredentialTool } from "../fetch-credential.js";
import { useCredentialTool } from "../use-credential.js";
import { buildToolRegistry } from "../index.js";

const SECRET = "sk-live-this-must-never-leak";

function mockApi(over: Partial<ApiClient>): ApiClient {
  return over as ApiClient;
}

const pending: CredentialFetchApproval = {
  approval_id: "fetch_1",
  approval_url: "https://trustysquire.ai/vault/fetch/fetch_1",
  status: "pending",
  credential: { reference: "vault://a/b/c", service: "OpenAI", name: "default" },
  field: null,
  field_names: ["value"],
  expires_at: "2026-09-05T12:10:00.000Z",
};

describe("fetch_credential", () => {
  it("returns an approval link and NO value on the first call", async () => {
    let seen: unknown;
    const api = mockApi({
      createCredentialFetchApproval: async (input) => {
        seen = input;
        return pending;
      },
    });
    const res = (await fetchCredentialTool.handler({ service: "OpenAI" }, api)) as Record<
      string,
      unknown
    >;
    expect(seen).toEqual({ service: "OpenAI" });
    expect(res.status).toBe("approval_pending");
    expect(res.approval_url).toBe("https://trustysquire.ai/vault/fetch/fetch_1");
    expect(res.next).toEqual({ tool: "fetch_credential", approval_id: "fetch_1" });
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(res).not.toHaveProperty("fields");
  });

  it("returns the value only on the delivered approval", async () => {
    const api = mockApi({
      getCredentialFetchApproval: async (id) => {
        expect(id).toBe("fetch_1");
        return {
          ...pending,
          status: "consumed",
          fields: { value: SECRET },
          fetched_at: "2026-09-05T12:05:00.000Z",
        };
      },
    });
    const res = (await fetchCredentialTool.handler({ approval_id: "fetch_1" }, api)) as Record<
      string,
      unknown
    >;
    expect(res.status).toBe("credential_fetched");
    expect(res.fields).toEqual({ value: SECRET });
  });

  it("keeps polling shape while the approval is still pending", async () => {
    const api = mockApi({ getCredentialFetchApproval: async () => pending });
    const res = (await fetchCredentialTool.handler({ approval_id: "fetch_1" }, api)) as Record<
      string,
      unknown
    >;
    expect(res.status).toBe("approval_pending");
    expect(res).not.toHaveProperty("fields");
  });

  it("renders denial, expiry, and replay as typed refusals with no value", async () => {
    for (const code of [
      "credential_fetch_denied",
      "credential_fetch_approval_expired",
      "credential_fetch_already_delivered",
      "credential_fetch_approval_not_pending",
    ]) {
      const api = mockApi({
        getCredentialFetchApproval: async () => {
          throw new ApiCallError(409, code, `GET → 409 ${code}`, {
            ...pending,
            status: "denied",
            error: code,
          });
        },
      });
      const res = (await fetchCredentialTool.handler({ approval_id: "fetch_1" }, api)) as Record<
        string,
        unknown
      >;
      expect(res.status, code).toBe("credential_fetch_refused");
      expect(res.reason, code).toBe(code);
      expect(res).not.toHaveProperty("fields");
    }
  });

  it("turns an ambiguous multi-field credential into an actionable retry", async () => {
    const api = mockApi({
      createCredentialFetchApproval: async () => {
        throw new ApiCallError(409, "ambiguous_credential_field", "409", {
          error: "ambiguous_credential_field",
          field_names: ["access_key_id", "secret_access_key"],
        });
      },
    });
    const res = (await fetchCredentialTool.handler({ service: "AWS" }, api)) as Record<
      string,
      unknown
    >;
    expect(res).toEqual({
      status: "credential_fetch_refused",
      reason: "ambiguous_credential_field",
      field_names: ["access_key_id", "secret_access_key"],
      remedy: "Retry fetch_credential with `field` set to one of field_names.",
    });
  });

  it("forwards a named field and reports the delivered field back", async () => {
    let seen: unknown;
    const api = mockApi({
      createCredentialFetchApproval: async (input) => {
        seen = input;
        return { ...pending, field: "secret_access_key", field_names: ["secret_access_key"] };
      },
    });
    await fetchCredentialTool.handler({ service: "AWS", field: "secret_access_key" }, api);
    expect(seen).toEqual({ service: "AWS", field: "secret_access_key" });
  });

  it("lets an unrelated API failure through rather than faking a refusal", async () => {
    const api = mockApi({
      createCredentialFetchApproval: async () => {
        throw new ApiCallError(404, "credential_not_found", "404 credential_not_found");
      },
    });
    await expect(fetchCredentialTool.handler({ service: "Nope" }, api)).rejects.toThrow(
      "credential_not_found",
    );
  });

  it("rejects a call that mixes a selector with an approval_id", () => {
    // The two modes are a union on purpose: resuming must not silently carry a
    // selector that the signed approval never covered.
    expect(
      fetchCredentialTool.inputSchema.safeParse({ approval_id: "fetch_1", service: "OpenAI" })
        .success,
    ).toBe(false);
    expect(fetchCredentialTool.inputSchema.safeParse({ field: "value" }).success).toBe(false);
    expect(fetchCredentialTool.inputSchema.safeParse({ service: "OpenAI" }).success).toBe(true);
    expect(fetchCredentialTool.inputSchema.safeParse({ approval_id: "fetch_1" }).success).toBe(
      true,
    );
  });
});

describe("fetch_credential's steering keeps use_credential the default", () => {
  it("names the approval, the transcript cost, and the cheaper route", async () => {
    const description = fetchCredentialTool.description;
    expect(description).toContain("passkey approval");
    expect(description).toContain("transcript");
    expect(description).toMatch(/Prefer \`use_credential\`/);
    expect(description).toContain("GitHub Actions secret");
    expect(description).toContain(".env");
    expect(description).toContain("single-use");
  });

  it("is registered after use_credential so the cheap route reads first", () => {
    const names = buildToolRegistry({}).map((tool) => tool.name);
    expect(names).toContain("fetch_credential");
    expect(names.indexOf("use_credential")).toBeLessThan(names.indexOf("fetch_credential"));
  });

  it("use_credential still promises the secret never crosses to the agent", () => {
    expect(useCredentialTool.description).toContain("NEVER crosses to this agent");
    // …and no longer claims a raw-value path is impossible, which it now isn't.
    expect(useCredentialTool.description).not.toContain("there is no raw-value extraction");
  });

  it("is not marked read-only: a fetch discloses and spends an approval", () => {
    expect(fetchCredentialTool.annotations).toMatchObject({
      destructiveHint: true,
      idempotentHint: false,
    });
  });
});
