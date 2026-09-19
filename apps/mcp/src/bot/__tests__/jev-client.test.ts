// askJev unit tests — platform /v1/decide by default, vaulted typesafe
// credential as BYOK override. Covers the measured request shape (choice
// criteria object, NEVER an `options` array; noul questions pass through
// verbatim), bounded retry/backoff on 503/529 through the route, the honest
// budget-exhausted failure, and strict response parsing.

import { describe, expect, it, vi } from "vitest";
import { ApiCallError, type ApiClient } from "../../api-client.js";
import {
  JEV_BYOK_CACHE_TTL_MS,
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_RETRY_BACKOFF_BASE_MS,
  JEV_RETRY_BUDGET_MS,
  JEV_RETRY_MAX_ATTEMPTS,
  JEV_SERVICE,
  JevUnavailableError,
  askJev,
} from "../jev-client.js";

type UseCredentialInput = Parameters<ApiClient["useCredential"]>[0];
type DecideArgs = Parameters<ApiClient["decide"]>;

function jevOk(body: unknown): { status: number; body: string } {
  return { status: 200, body: JSON.stringify(body) };
}

function vaultOk(body: unknown): {
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
} {
  return { response: { status: 200, headers: {}, body: JSON.stringify(body), truncated: false } };
}

function credentialSummary(service: string | null) {
  return {
    id: "id",
    reference: "ref",
    service,
    label: "default",
    field_names: ["value"],
    key_name: null,
    type: "api_key",
    allowed_hosts: [],
    auth_strategy: "api_key",
    signin_url: null,
    login_hosts: [],
    created_at: "2026-01-01T00:00:00Z",
    last_retrieved_at: null,
    retrieval_count: 0,
  };
}

function mockApi(opts: {
  credentials?: Array<{ service: string | null }>;
  decide?: (...args: DecideArgs) => ReturnType<ApiClient["decide"]>;
  useCredential?: (input: UseCredentialInput) => ReturnType<ApiClient["useCredential"]>;
  listCredentials?: () => ReturnType<ApiClient["listCredentials"]>;
}): ApiClient {
  return {
    listCredentials: vi.fn(
      opts.listCredentials ??
        (() =>
          Promise.resolve({
            credentials: (opts.credentials ?? []).map((c) => credentialSummary(c.service)),
          })),
    ),
    decide: vi.fn(
      opts.decide ?? (() => Promise.resolve(jevOk({ answers: { pick: { choice: "@e:reveal" } } }))),
    ),
    useCredential: vi.fn(
      opts.useCredential ??
        (() => Promise.resolve(vaultOk({ answers: { pick: { choice: "@e:reveal" } } }))),
    ),
  } as unknown as ApiClient;
}

const QUESTIONS = {
  pick: {
    type: "choice" as const,
    instructions: "Which element advances the goal?",
    criteria: { "@e:reveal": "reveal button", "@e:key-name": "key name textbox" },
  },
  stuck: { type: "noul" as const, instructions: "Is the operator stuck?" },
};

describe("askJev request mapping", () => {
  it("serializes structured drive state once for platform while preserving BYOK objects", async () => {
    const state = { goal: "fill form", history: [], elements: [{ ref: "@e:one", description: "Email", required: true }] };
    const platform = mockApi({});
    await askJev(platform, state, QUESTIONS);
    expect(vi.mocked(platform.decide).mock.calls[0]![0]).toBe(JSON.stringify(state));
    const byok = mockApi({ credentials: [{ service: "typesafe" }] });
    await askJev(byok, state, QUESTIONS);
    const input = vi.mocked(byok.useCredential).mock.calls[0]![0]!;
    expect(JSON.parse(input.http.body!).state).toEqual(state);
  });

  it("sends the measured request shape through POST /v1/decide by default", async () => {
    const api = mockApi({
      decide: () =>
        Promise.resolve(jevOk({ model: JEV_MODEL, answers: { pick: { choice: "@e:reveal" } } })),
    });
    await askJev(api, "https://fixture.test/page — page state", QUESTIONS);

    expect(api.decide).toHaveBeenCalledTimes(1);
    expect(api.useCredential).not.toHaveBeenCalled();
    const [state, questions] = vi.mocked(api.decide).mock.calls[0]!;
    expect(state).toBe("https://fixture.test/page — page state");
    expect(questions).toEqual(QUESTIONS);
    expect(JSON.stringify(questions)).not.toContain('"options":[');
  });

  it("uses the vault path when a typesafe credential exists", async () => {
    const api = mockApi({
      credentials: [{ service: "typesafe" }],
      useCredential: () =>
        Promise.resolve(vaultOk({ model: JEV_MODEL, answers: { pick: { choice: "@e:reveal" } } })),
    });
    await askJev(api, "https://fixture.test/page — page state", QUESTIONS);

    expect(api.useCredential).toHaveBeenCalledTimes(1);
    expect(api.decide).not.toHaveBeenCalled();
    const input = vi.mocked(api.useCredential).mock.calls[0]![0]!;
    expect(input.service).toBe(JEV_SERVICE);
    expect(input.http.url).toBe(JEV_ENDPOINT);
    expect(input.http.method).toBe("POST");
    expect(input.http.headers?.authorization).toBe("Bearer ${SECRET}");
    expect(input.http.headers?.["content-type"]).toBe("application/json");

    const body = JSON.parse(input.http.body!) as {
      model: string;
      state: unknown;
      questions: typeof QUESTIONS;
    };
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state).toBe("https://fixture.test/page — page state");
    expect(body.questions).toEqual(QUESTIONS);
    expect(JSON.stringify(body)).not.toContain('"options":[');
  });

  it("lists credentials once per client and caches the BYOK decision", async () => {
    const api = mockApi({});
    await askJev(api, "state", QUESTIONS);
    await askJev(api, "state", QUESTIONS);
    expect(api.listCredentials).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledTimes(2);
  });

  it("picks up a credential vaulted after a cached miss once the TTL lapses", async () => {
    let vaulted = false;
    const api = mockApi({
      listCredentials: () =>
        Promise.resolve({
          credentials: vaulted ? [credentialSummary("typesafe")] : [],
        }),
    });
    await askJev(api, "state", QUESTIONS);
    expect(api.decide).toHaveBeenCalledTimes(1);

    vaulted = true;
    await askJev(api, "state", QUESTIONS);
    expect(api.decide).toHaveBeenCalledTimes(2);
    expect(api.useCredential).not.toHaveBeenCalled();

    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + JEV_BYOK_CACHE_TTL_MS + 1);
    try {
      await askJev(api, "state", QUESTIONS);
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(api.listCredentials).toHaveBeenCalledTimes(2);
    expect(api.useCredential).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledTimes(2);
  });

  it("falls back to the platform route when the vaulted credential is gone", async () => {
    const api = mockApi({
      credentials: [{ service: "typesafe" }],
      useCredential: () =>
        Promise.reject(
          new ApiCallError(404, "credential_not_found", "POST /v1/vault/use → 404", {
            error: "credential_not_found",
          }),
        ),
      decide: () =>
        Promise.resolve(jevOk({ model: JEV_MODEL, answers: { pick: { choice: "@e:reveal" } } })),
    });

    const outcome = await askJev(api, "state", QUESTIONS);
    expect(outcome.result.answers.pick).toEqual({ choice: "@e:reveal" });
    expect(api.useCredential).toHaveBeenCalledTimes(1);
    expect(api.decide).toHaveBeenCalledTimes(1);

    // The stale BYOK cache entry is dropped, so the next call re-detects
    // instead of retrying the deleted credential.
    await askJev(api, "state", QUESTIONS);
    expect(api.listCredentials).toHaveBeenCalledTimes(2);
  });

  it("propagates a non-404 vault failure instead of masking it as no-BYOK", async () => {
    const api = mockApi({
      credentials: [{ service: "typesafe" }],
      useCredential: () =>
        Promise.reject(new ApiCallError(403, "host_not_allowed", "POST /v1/vault/use → 403")),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toBeInstanceOf(ApiCallError);
    expect(api.decide).not.toHaveBeenCalled();
  });

  it("returns the parsed answers with attempts and elapsed time", async () => {
    const api = mockApi({
      decide: () =>
        Promise.resolve(
          jevOk({
            model: JEV_MODEL,
            usage: { input_tokens: 420, output_tokens: 73 },
            answers: {
              pick: { choice: "@e:reveal", confidence: 0.97, probabilities: { "@e:reveal": 0.97 } },
              stuck: { noul: 0.02 },
            },
          }),
        ),
    });
    const outcome = await askJev(api, "state", QUESTIONS);
    expect(outcome.attempts).toBe(1);
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(outcome.result).toMatchObject({
      model: JEV_MODEL,
      usage: { input_tokens: 420, output_tokens: 73 },
      answers: {
        pick: { choice: "@e:reveal", confidence: 0.97, probabilities: { "@e:reveal": 0.97 } },
        stuck: { noul: 0.02 },
      },
    });
  });
});

describe("askJev response parsing", () => {
  it("rejects a non-JSON body honestly", async () => {
    const api = mockApi({
      decide: () => Promise.resolve({ status: 200, body: "<html>oops</html>" }),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toThrow(/jev_invalid_response/);
  });

  it("rejects a response with no answers object", async () => {
    const api = mockApi({
      decide: () => Promise.resolve(jevOk({ model: JEV_MODEL })),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toThrow(/jev_invalid_response.*answers/);
  });

  it("rejects a non-object answer entry", async () => {
    const api = mockApi({
      decide: () => Promise.resolve(jevOk({ answers: { pick: "reveal" } })),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toThrow(/jev_invalid_response.*"pick"/);
  });
});

describe("askJev retry on transient unavailability", () => {
  async function advanceUntilSettled<T>(
    pending: Promise<T>,
    stepMs = 500,
    maxSteps = 60,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    let settled = false;
    const tracked = pending.then(
      (value) => {
        settled = true;
        return { ok: true as const, value };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    for (let i = 0; i < maxSteps && !settled; i++) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    return await tracked;
  }

  function transient(status: number): { status: number; body: string } {
    return {
      status,
      body: JSON.stringify({
        detail: {
          error_type: status === 503 ? "model_unavailable" : "system_overloaded",
          message: "try again",
        },
      }),
    };
  }

  it.each([503, 529])(
    "retries HTTP %d through the route with exponential backoff and succeeds",
    async (status) => {
      vi.useFakeTimers();
      try {
        let calls = 0;
        const api = mockApi({
          decide: () => {
            calls++;
            if (calls <= 2) return Promise.resolve(transient(status));
            return Promise.resolve(
              jevOk({ answers: { pick: { choice: "@e:reveal", confidence: 0.9 } } }),
            );
          },
        });
        const outcome = await advanceUntilSettled(askJev(api, "state", QUESTIONS));
        expect(calls).toBe(3);
        expect(outcome).toMatchObject({ ok: true, value: { attempts: 3 } });
        expect(api.useCredential).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails honestly with NO decision when the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const api = mockApi({
        decide: () => {
          calls++;
          return Promise.resolve(transient(503));
        },
      });
      const outcome = await advanceUntilSettled(askJev(api, "state", QUESTIONS));
      expect(calls).toBe(JEV_RETRY_MAX_ATTEMPTS);
      expect(outcome.ok).toBe(false);
      const failure = (outcome as { ok: false; error: unknown }).error;
      expect(failure).toBeInstanceOf(JevUnavailableError);
      const message = (failure as JevUnavailableError).message;
      expect(message).toContain("503/503/503/503/503");
      expect(message).toContain("NO decision was made");
      expect(message).toContain("Do not guess");
      expect((failure as JevUnavailableError).attempts).toBe(JEV_RETRY_MAX_ATTEMPTS);
      expect(JEV_RETRY_BACKOFF_BASE_MS * (2 ** JEV_RETRY_MAX_ATTEMPTS - 1)).toBeLessThan(
        JEV_RETRY_BUDGET_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately (no retry) on a non-transient upstream status", async () => {
    const api = mockApi({
      decide: () => Promise.resolve({ status: 401, body: '{"detail":"unauthorized"}' }),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toThrow(/jev_request_failed.*401/);
    expect(api.decide).toHaveBeenCalledTimes(1);
  });

  it("treats platform 504 jev_timeout as unavailable", async () => {
    const api = mockApi({
      decide: () => Promise.resolve({ status: 504, body: '{"error":"jev_timeout"}' }),
    });
    await expect(askJev(api, "state", QUESTIONS)).rejects.toBeInstanceOf(JevUnavailableError);
    expect(api.decide).toHaveBeenCalledTimes(1);
  });
});
