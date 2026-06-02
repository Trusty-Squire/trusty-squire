// T-F3 — registry→API funnel client + the cross-package contract.
// The fixture funnel-response.json is the canonical /v1/admin/funnel
// shape; the API side (apps/api admin-funnel.test) asserts its endpoint
// emits these keys, and this test asserts the registry client parses
// them — so a field rename on either side breaks a test, not prod.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fetchApiFunnel } from "../funnel-api-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/funnel-response.json", import.meta.url));
const FIXTURE = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const WIN = { apiBase: "https://api.test", token: "t", start: new Date("2026-05-02"), end: new Date("2026-06-01") };

describe("funnel-response contract fixture", () => {
  it("has exactly the keys the registry client + API endpoint agree on", () => {
    expect(Object.keys(FIXTURE).sort()).toEqual(
      ["accounts_created", "as_of", "new_accounts_series", "npm_downloads", "tokens_issued", "window_end", "window_start"].sort(),
    );
  });
});

describe("fetchApiFunnel", () => {
  it("parses a valid response (the fixture)", async () => {
    const out = await fetchApiFunnel({ ...WIN, fetchFn: jsonFetch(FIXTURE) });
    expect(out).not.toBeNull();
    expect(out?.tokens_issued).toBe(2310);
    expect(out?.accounts_created).toBe(1540);
    expect(out?.npm_downloads).toBe(18400);
    expect(out?.new_accounts_series).toHaveLength(2);
  });

  it("passes explicit window bounds in the query string", async () => {
    let seen = "";
    const f = (async (url: Parameters<typeof fetch>[0]) => {
      seen = url.toString();
      return new Response(JSON.stringify(FIXTURE), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await fetchApiFunnel({ ...WIN, fetchFn: f });
    expect(seen).toContain("/v1/admin/funnel?");
    expect(seen).toContain("window_start=2026-05-02");
    expect(seen).toContain("window_end=2026-06-01");
  });

  it("fail-soft → null on a non-200", async () => {
    expect(await fetchApiFunnel({ ...WIN, fetchFn: jsonFetch({}, 500) })).toBeNull();
  });

  it("fail-soft → null on a shape mismatch (missing tokens_issued)", async () => {
    const bad = { ...FIXTURE };
    delete (bad as Record<string, unknown>).tokens_issued;
    expect(await fetchApiFunnel({ ...WIN, fetchFn: jsonFetch(bad) })).toBeNull();
  });

  it("fail-soft → null on timeout (abort)", async () => {
    // A fetch that never resolves but rejects when the abort signal fires.
    const hang = ((_url: Parameters<typeof fetch>[0], init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    expect(await fetchApiFunnel({ ...WIN, fetchFn: hang, timeoutMs: 10 })).toBeNull();
  });
});
