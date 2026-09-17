// operate_decide unit tests — request mapping (measured Jev shapes: choice
// criteria object, NEVER an `options` array; noul), answer mapping back to
// refs/values, bounded retry/backoff on 503/529, and the honest
// budget-exhausted failure. The session plumbing (real observe + call lease)
// is exercised by the real-browser test; here the facade is mocked to a
// pass-through so these stay fast and non-browser.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import type * as ProvisionSessionModule from "../../bot/provision-session.js";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_RETRY_BACKOFF_BASE_MS,
  JEV_RETRY_BUDGET_MS,
  JEV_RETRY_MAX_ATTEMPTS,
  JEV_SERVICE,
  JevUnavailableError,
} from "../../bot/jev-client.js";

const observe = vi.fn();
const withProvisionSessionCall = vi.fn(
  async (_sessionId: string, fn: (session: unknown) => Promise<unknown>, _signal?: AbortSignal) =>
    await fn(undefined),
);

vi.mock("../../bot/provision-session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProvisionSessionModule>();
  return {
    ...actual,
    observe: (...args: Parameters<typeof observe>) => observe(...args),
    withProvisionSessionCall: (
      sessionId: string,
      fn: (session: unknown) => Promise<unknown>,
      signal?: AbortSignal,
    ) => withProvisionSessionCall(sessionId, fn, signal),
  };
});

import { operateDecideTool } from "../operate-decide.js";

type UseCredentialInput = Parameters<ApiClient["useCredential"]>[0];

// Compact-map wire rows, exactly as the observation serializes them:
// [ref, roleLetter, facts?] with facts a `|`-joined list.
type WireRow = [string, string, string?];

interface RowSpec {
  ref: string;
  role: "button" | "textbox" | "generic";
  label?: string;
  action?: string;
  field?: string;
  offscreen?: boolean;
  notFillable?: boolean;
}

const ROLE_LETTER: Record<RowSpec["role"], string> = {
  button: "b",
  textbox: "t",
  generic: "generic",
};

function row(spec: RowSpec): WireRow {
  const facts = [
    ...(spec.label !== undefined ? [`@${spec.label}`] : []),
    ...(spec.offscreen === true ? ["v=offscreen"] : []),
    ...(spec.action !== undefined ? [`a=${spec.action}`] : []),
    ...(spec.field !== undefined ? [`f=${spec.field}`] : []),
    ...(spec.notFillable === true ? ["nf=1"] : []),
  ];
  return facts.length === 0
    ? [spec.ref, ROLE_LETTER[spec.role]]
    : [spec.ref, ROLE_LETTER[spec.role], facts.join("|")];
}

function observation(
  safe_table: WireRow[],
  url = "https://fixture.test/keys",
): {
  session_id: string;
  url: string;
  stage: "form";
  safe_table: WireRow[];
  semantic: { title: string; headings: string[] };
} {
  return {
    session_id: "s1",
    url,
    stage: "form",
    safe_table: safe_table,
    semantic: { title: "API keys", headings: ["API keys — synthetic test account"] },
  };
}

function jevOk(body: unknown): {
  response: { status: number; headers: Record<string, string>; body: string; truncated: boolean };
} {
  return { response: { status: 200, headers: {}, body: JSON.stringify(body), truncated: false } };
}

function mockApi(
  impl: (input: UseCredentialInput) => ReturnType<ApiClient["useCredential"]>,
): ApiClient {
  return { useCredential: vi.fn(impl) } as unknown as ApiClient;
}

const PAGE_ROWS: WireRow[] = [
  row({ ref: "@e:reveal", role: "button", label: "reveal" }),
  row({ ref: "@e:key-name", role: "textbox", label: "key-name", field: "name" }),
  row({ ref: "@e:pay", role: "button", label: "pay-now", action: "payment" }),
  row({ ref: "@e:card", role: "textbox", label: "card-number", field: "payment" }),
  row({ ref: "@e:offscreen", role: "button", label: "offscreen", offscreen: true }),
  row({ ref: "@e:container", role: "generic", label: "card", field: "payment", notFillable: true }),
];

beforeEach(() => {
  observe.mockReset();
  withProvisionSessionCall.mockClear();
});

describe("operate_decide request mapping", () => {
  it("asks one pick choice over live refs plus a stuck noul, through the vaulted credential", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(
        jevOk({
          model: JEV_MODEL,
          answers: { pick: { choice: "@e:reveal", confidence: 0.97 }, stuck: { noul: 0.02 } },
        }),
      ),
    );
    await operateDecideTool.handler({ session_id: "s1", goal: "Reveal the API key" }, api);

    const input = vi.mocked(api.useCredential).mock.calls[0]![0]!;
    expect(input.service).toBe(JEV_SERVICE);
    expect(input.http.url).toBe(JEV_ENDPOINT);
    expect(input.http.headers?.authorization).toBe("Bearer ${SECRET}");

    const body = JSON.parse(input.http.body!) as {
      model: string;
      state: string;
      questions: Record<
        string,
        { type: string; instructions: string; criteria?: Record<string, string> }
      >;
    };
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state).toContain("https://fixture.test/keys");
    expect(body.state).toContain("API keys");
    expect(body.questions.pick!.type).toBe("choice");
    expect(body.questions.pick!.instructions).toBe("Reveal the API key");
    // Criteria object keyed by ref, with an `options` array never sent.
    expect(Object.keys(body.questions.pick!.criteria!)).toEqual(["@e:reveal", "@e:key-name"]);
    expect(JSON.stringify(body)).not.toContain('"options":[');
    expect(body.questions.stuck!.type).toBe("noul");
    // The stuck question is self-contained: it carries the goal text and the
    // number of offered criteria, so it scores correctly even when read
    // independently of the pick question in the same batch.
    expect(body.questions.stuck!.instructions).toContain("Reveal the API key");
    expect(body.questions.stuck!.instructions).toContain("exactly 2 page");
  });

  it("excludes payment elements, offscreen controls, and notFillable containers", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(jevOk({ answers: { pick: { choice: "@e:reveal" } } })),
    );
    await operateDecideTool.handler({ session_id: "s1", goal: "g" }, api);
    const body = JSON.parse(vi.mocked(api.useCredential).mock.calls[0]![0]!.http.body!) as {
      questions: { pick: { criteria: Record<string, string> } };
    };
    expect(Object.keys(body.questions.pick!.criteria)).not.toContain("@e:pay");
    expect(Object.keys(body.questions.pick!.criteria)).not.toContain("@e:card");
    expect(Object.keys(body.questions.pick!.criteria)).not.toContain("@e:offscreen");
    expect(Object.keys(body.questions.pick!.criteria)).not.toContain("@e:container");
  });

  it("caps the page criteria at 40 options and reports offered vs eligible counts", async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      row({ ref: `@e:c${i}`, role: "button", label: `c${i}` }),
    );
    observe.mockResolvedValue(observation(many));
    const api = mockApi(() => Promise.resolve(jevOk({ answers: { pick: { choice: "@e:c0" } } })));
    const out = (await operateDecideTool.handler({ session_id: "s1", goal: "g" }, api)) as {
      candidates: { offered: number; eligible: number };
    };
    const body = JSON.parse(vi.mocked(api.useCredential).mock.calls[0]![0]!.http.body!) as {
      questions: { pick: { criteria: Record<string, string> } };
    };
    expect(Object.keys(body.questions.pick!.criteria)).toHaveLength(40);
    expect(out.candidates).toEqual({ offered: 40, eligible: 60 });
  });

  it("passes caller-provided options through as the choice criteria", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(jevOk({ answers: { pick: { choice: "free-plan", confidence: 0.9 } } })),
    );
    const out = (await operateDecideTool.handler(
      {
        session_id: "s1",
        goal: "Which plan matches the user's ask?",
        decision: { type: "choice", options: { "free-plan": "Free", "pro-plan": "Pro" } },
      },
      api,
    )) as { decision: string; value: string };
    const body = JSON.parse(vi.mocked(api.useCredential).mock.calls[0]![0]!.http.body!) as {
      questions: { pick: { criteria: Record<string, string>; instructions: string } };
    };
    expect(body.questions.pick!.criteria).toEqual({ "free-plan": "Free", "pro-plan": "Pro" });
    expect(out).toMatchObject({ decision: "pick_option", value: "free-plan", confidence: 0.9 });
  });

  it("noul mode sends a single noul question and maps the yes/no probability", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(jevOk({ answers: { check: { noul: 0.06, confidence: 0.91 } } })),
    );
    const out = (await operateDecideTool.handler(
      { session_id: "s1", goal: "The form is complete.", decision: { type: "noul" } },
      api,
    )) as { decision: string; noul: number; confidence: number };
    const body = JSON.parse(vi.mocked(api.useCredential).mock.calls[0]![0]!.http.body!) as {
      questions: Record<string, { type: string; instructions: string }>;
    };
    expect(body.questions.check!).toEqual({ type: "noul", instructions: "The form is complete." });
    expect(out).toMatchObject({ decision: "noul", noul: 0.06, confidence: 0.91 });
  });
});

describe("operate_decide answer mapping", () => {
  it("maps a pick_ref answer back to the concrete ref with role and label", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(
        jevOk({
          model: JEV_MODEL,
          usage: { input_tokens: 420, output_tokens: 73 },
          answers: {
            pick: {
              choice: "@e:key-name",
              confidence: 0.95,
              probabilities: { "@e:reveal": 0.02, "@e:key-name": 0.95 },
            },
            stuck: { noul: 0.01 },
          },
        }),
      ),
    );
    const out = (await operateDecideTool.handler(
      { session_id: "s1", goal: "Where does the key name go?" },
      api,
    )) as Record<string, unknown>;
    expect(out).toMatchObject({
      decision: "pick_ref",
      ref: "@e:key-name",
      role: "textbox",
      label: "key-name",
      confidence: 0.95,
      probabilities: { "@e:reveal": 0.02, "@e:key-name": 0.95 },
      stuck: { noul: 0.01 },
      model: JEV_MODEL,
      usage: { input_tokens: 420, output_tokens: 73 },
    });
    // The untruncated sweep is visible to the caller: all eligible rows were
    // offered (payment/offscreen/notFillable rows never reach the pool).
    expect(out).toMatchObject({ candidates: { offered: 2, eligible: 2 } });
    expect(out).toHaveProperty("elapsed_ms");
  });

  it("fails honestly when the model answers with an unoffered option", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() => Promise.resolve(jevOk({ answers: { pick: { choice: "@e:pay" } } })));
    await expect(operateDecideTool.handler({ session_id: "s1", goal: "g" }, api)).rejects.toThrow(
      /jev_invalid_response.*@e:pay/,
    );
  });

  it("rejects prototype names as an unoffered option", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve(jevOk({ answers: { pick: { choice: "constructor" } } })),
    );
    await expect(operateDecideTool.handler({ session_id: "s1", goal: "g" }, api)).rejects.toThrow(
      /jev_invalid_response.*"constructor"/,
    );
    await expect(
      operateDecideTool.handler(
        {
          session_id: "s1",
          goal: "g",
          decision: { type: "choice", options: { a: "A", toString: "T" } },
        },
        mockApi(() => Promise.resolve(jevOk({ answers: { pick: { choice: "valueOf" } } }))),
      ),
    ).rejects.toThrow(/jev_invalid_response.*"valueOf"/);
  });

  it("throws when no actionable controls are visible", async () => {
    observe.mockResolvedValue(observation([]));
    const api = mockApi(() => {
      throw new Error("must not be called");
    });
    await expect(operateDecideTool.handler({ session_id: "s1", goal: "g" }, api)).rejects.toThrow(
      /nothing to decide/,
    );
  });

  it("requires the api-client (the vaulted credential path)", async () => {
    await expect(operateDecideTool.handler({ session_id: "s1", goal: "g" }, null)).rejects.toThrow(
      /connect/,
    );
  });
});

describe("operate_decide retry on transient unavailability", () => {
  // Drives fake timers until the in-flight decide settles, so the test can't
  // deadlock on a backoff wait that lands past the last advance.
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

  it.each([503, 529])("retries HTTP %d with exponential backoff and succeeds", async (status) => {
    vi.useFakeTimers();
    try {
      observe.mockResolvedValue(observation(PAGE_ROWS));
      let calls = 0;
      const api = mockApi(() => {
        calls++;
        if (calls <= 2) {
          return Promise.resolve({
            response: {
              status,
              headers: {},
              body: JSON.stringify({
                detail: {
                  error_type: status === 503 ? "model_unavailable" : "system_overloaded",
                  message: "try again",
                },
              }),
              truncated: false,
            },
          });
        }
        return Promise.resolve(
          jevOk({ answers: { pick: { choice: "@e:reveal", confidence: 0.9 } } }),
        );
      });
      const outcome = await advanceUntilSettled(
        operateDecideTool.handler({ session_id: "s1", goal: "g" }, api) as Promise<unknown>,
      );
      expect(calls).toBe(3);
      expect(outcome).toMatchObject({ ok: true, value: { attempts: 3 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails honestly with NO decision when the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      observe.mockResolvedValue(observation(PAGE_ROWS));
      let calls = 0;
      const api = mockApi(() => {
        calls++;
        return Promise.resolve({
          response: {
            status: 503,
            headers: {},
            body: '{"detail":{"error_type":"model_unavailable"}}',
            truncated: false,
          },
        });
      });
      const outcome = await advanceUntilSettled(
        operateDecideTool.handler({ session_id: "s1", goal: "g" }, api) as Promise<unknown>,
      );
      expect(calls).toBe(JEV_RETRY_MAX_ATTEMPTS);
      expect(outcome.ok).toBe(false);
      const failure = (outcome as { ok: false; error: unknown }).error;
      expect(failure).toBeInstanceOf(JevUnavailableError);
      const message = (failure as JevUnavailableError).message;
      expect(message).toContain("503/503/503/503/503");
      expect(message).toContain("NO decision was made");
      expect(message).toContain("Do not guess");
      expect((failure as JevUnavailableError).attempts).toBe(JEV_RETRY_MAX_ATTEMPTS);
      // The total budget is stated and honored: 400+800+1600+3200 = 6000ms of
      // backoff stays inside JEV_RETRY_BUDGET_MS.
      expect(JEV_RETRY_BACKOFF_BASE_MS * (2 ** JEV_RETRY_MAX_ATTEMPTS - 1)).toBeLessThan(
        JEV_RETRY_BUDGET_MS,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately (no retry) on a non-transient upstream status", async () => {
    observe.mockResolvedValue(observation(PAGE_ROWS));
    const api = mockApi(() =>
      Promise.resolve({
        response: { status: 401, headers: {}, body: '{"detail":"unauthorized"}', truncated: false },
      }),
    );
    await expect(operateDecideTool.handler({ session_id: "s1", goal: "g" }, api)).rejects.toThrow(
      /jev_request_failed.*401/,
    );
    expect(api.useCredential).toHaveBeenCalledTimes(1);
  });
});
