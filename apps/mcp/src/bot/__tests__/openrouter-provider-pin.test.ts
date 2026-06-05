// UNIVERSAL_BOT_OR_PROVIDER pins the Gemini primary to one OpenRouter backend
// for a deterministic offline eval. It must NOT pin the Anthropic premium
// fallback (a Google provider can't serve it → guaranteed 404).

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenRouterClient } from "../llm-client.js";

function mockFetchOnce(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const REQ = { system: "s", user: [{ kind: "text" as const, text: "u" }], max_tokens: 8 };

afterEach(() => {
  delete process.env.UNIVERSAL_BOT_OR_PROVIDER;
});

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body);
}

describe("OpenRouter provider pin (UNIVERSAL_BOT_OR_PROVIDER)", () => {
  it("pins the Gemini primary + sets a seed when the env is set", async () => {
    process.env.UNIVERSAL_BOT_OR_PROVIDER = "Google AI Studio";
    const fetchMock = mockFetchOnce();
    await new OpenRouterClient({ apiKey: "k", model: "google/gemini-flash-1.5" }).createMessage(REQ);
    const body = bodyOf(fetchMock);
    expect(body["provider"]).toEqual({ order: ["Google AI Studio"], allow_fallbacks: false });
    expect(body["seed"]).toBe(1);
  });

  it("does NOT pin a non-Google model (the Anthropic premium fallback)", async () => {
    process.env.UNIVERSAL_BOT_OR_PROVIDER = "Google AI Studio";
    const fetchMock = mockFetchOnce();
    await new OpenRouterClient({ apiKey: "k", model: "anthropic/claude-sonnet-4.5" }).createMessage(REQ);
    expect("provider" in bodyOf(fetchMock)).toBe(false);
  });

  it("omits provider entirely when the env is unset (production routing)", async () => {
    const fetchMock = mockFetchOnce();
    await new OpenRouterClient({ apiKey: "k", model: "google/gemini-flash-1.5" }).createMessage(REQ);
    expect("provider" in bodyOf(fetchMock)).toBe(false);
  });
});
