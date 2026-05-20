// Pluggable LLM client for the signup agent.
//
// The agent only needs one capability: take an image + text → reply text.
// We abstract that into LLMClient so we can pick the cheapest source
// available at runtime:
//
//   1. MCP Sampling (when the bot is hosted inside an MCP server). The host
//      agent (Claude Desktop, Cursor) makes the call on its own subscription.
//      → Zero cost to Trusty Squire, zero marginal cost to the user.
//
//   2. OpenRouter (when OPENROUTER_API_KEY is set). Routes to the user's
//      preferred OR our defaults, with explicit "cheapest serviceable"
//      preset that prefers vision-capable cheap models (Claude Haiku,
//      Gemini Flash, GPT-4o-mini) in cost order.
//      → User pays OpenRouter directly.
//
//   3. Anthropic direct (when ANTHROPIC_API_KEY is set). Same shape as
//      today; safest fallback because we know it works.
//      → User pays Anthropic directly when it's their key, or Trusty
//        Squire pays when it's ours.
//
// The factory `pickLLMClient()` walks these in order at construction time.
// The agent itself only sees LLMClient and never knows which backend won.

import Anthropic from "@anthropic-ai/sdk";

// ── Wire format (intentionally narrow — only what the agent uses) ──

export interface LLMVisionBlock {
  kind: "image";
  media_type: "image/png";
  data_base64: string;
}

export interface LLMTextBlock {
  kind: "text";
  text: string;
}

export type LLMBlock = LLMVisionBlock | LLMTextBlock;

export interface LLMRequest {
  system: string;
  user: LLMBlock[];
  max_tokens: number;
}

export interface LLMResponse {
  text: string;
  // Best-effort: not every backend surfaces token counts. We use it for
  // logging only.
  input_tokens?: number;
  output_tokens?: number;
  // Identifies which backend handled this so the agent can surface it
  // in step logs.
  backend: string;
}

export interface LLMClient {
  readonly name: string;
  createMessage(req: LLMRequest): Promise<LLMResponse>;
}

// ── Anthropic direct ──

export class AnthropicDirectClient implements LLMClient {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.name = `anthropic:${this.model}`;
  }

  async createMessage(req: LLMRequest): Promise<LLMResponse> {
    const content = req.user.map((b) =>
      b.kind === "image"
        ? {
            type: "image" as const,
            source: { type: "base64" as const, media_type: b.media_type, data: b.data_base64 },
          }
        : { type: "text" as const, text: b.text },
    );
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: req.max_tokens,
      system: req.system,
      messages: [{ role: "user", content }],
    });
    const textBlock = resp.content.find((b) => b.type === "text");
    if (textBlock === undefined || textBlock.type !== "text") {
      throw new Error(`${this.name}: no text block in response`);
    }
    return {
      text: textBlock.text,
      input_tokens: resp.usage.input_tokens,
      output_tokens: resp.usage.output_tokens,
      backend: this.name,
    };
  }
}

// ── OpenRouter ──
//
// Uses the OpenAI-compatible /chat/completions endpoint. Vision blocks
// follow OpenAI's `image_url` shape with a `data:` URI.

export interface OpenRouterClientOpts {
  apiKey: string;
  // The model slug to use. Examples:
  //   "google/gemini-2.0-flash-001"       ← cheap, vision-capable
  //   "openai/gpt-4o-mini"                ← cheap, vision-capable
  //   "anthropic/claude-sonnet-4.5"       ← premium, vision-capable
  //   "openrouter/auto"                   ← let OR pick
  // When omitted, defaults to OPENROUTER_MODEL env or "openrouter/auto".
  model?: string;
  // OpenRouter's "model preferences" feature — pass a list to fall back
  // automatically if the primary is unavailable.
  fallbackModels?: string[];
  // App attribution headers (recommended by OR).
  appName?: string;
  appUrl?: string;
}

export class OpenRouterClient implements LLMClient {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fallbackModels: string[];
  private readonly appName: string;
  private readonly appUrl: string;

  constructor(opts: OpenRouterClientOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? process.env.OPENROUTER_MODEL ?? "openrouter/auto";
    this.fallbackModels = opts.fallbackModels ?? [];
    this.appName = opts.appName ?? "Trusty Squire";
    this.appUrl = opts.appUrl ?? "https://trustysquire.ai";
    this.name = `openrouter:${this.model}`;
  }

  async createMessage(req: LLMRequest): Promise<LLMResponse> {
    const userContent: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = req.user.map((b) =>
      b.kind === "image"
        ? {
            type: "image_url" as const,
            image_url: { url: `data:${b.media_type};base64,${b.data_base64}` },
          }
        : { type: "text" as const, text: b.text },
    );

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.max_tokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
    };
    if (this.fallbackModels.length > 0) {
      // OpenRouter caps the `models` routing array at 3 items — a
      // longer list is a hard 400 ("'models' array must have 3 items
      // or fewer"). Cap defensively so an over-long fallback list
      // degrades to "first 3" instead of failing the whole call.
      body["models"] = [this.model, ...this.fallbackModels].slice(0, 3);
    }

    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "HTTP-Referer": this.appUrl,
        "X-Title": this.appName,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.name}: ${resp.status} ${text.slice(0, 300)}`);
    }
    const data = (await resp.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    const content = data.choices[0]?.message.content;
    if (typeof content !== "string") {
      throw new Error(`${this.name}: no content in response`);
    }
    return {
      text: content,
      ...(data.usage?.prompt_tokens !== undefined ? { input_tokens: data.usage.prompt_tokens } : {}),
      ...(data.usage?.completion_tokens !== undefined ? { output_tokens: data.usage.completion_tokens } : {}),
      backend: data.model !== undefined ? `openrouter:${data.model}` : this.name,
    };
  }
}

// ── Trusty Squire LLM proxy ──
//
// For users who haven't BYOK'd an LLM provider, the bot talks to a proxy
// endpoint we host that forwards to OpenRouter (or any provider we wire
// up server-side). The user pays nothing for LLM calls in active-mode because
// the proxy uses the operator's OpenRouter key — but the server enforces
// a rolling rate limit per machine token so a single user can't drain
// our wallet.

export interface ProxyLLMClientOpts {
  // Trusty Squire API base URL (default https://trusty-squire-api.fly.dev).
  apiBaseUrl: string;
  // Machine token issued at MCP install. Acts as the bearer here.
  machineToken: string;
  // "cheap" routes to Gemini Flash on the server. "premium" routes to
  // Sonnet — used by the parse-failure fallback path.
  tier: "cheap" | "premium";
}

export class ProxyLLMClient implements LLMClient {
  readonly name: string;
  private readonly apiBaseUrl: string;
  private readonly machineToken: string;
  private readonly tier: "cheap" | "premium";

  constructor(opts: ProxyLLMClientOpts) {
    this.apiBaseUrl = opts.apiBaseUrl.replace(/\/+$/, "");
    this.machineToken = opts.machineToken;
    this.tier = opts.tier;
    this.name = `trusty-squire-proxy:${this.tier}`;
  }

  async createMessage(req: LLMRequest): Promise<LLMResponse> {
    // Translate the universal LLMRequest into the proxy's wire format.
    // The shapes line up almost exactly because we defined them
    // intentionally narrow.
    const body = {
      system: req.system,
      user: req.user.map((b) =>
        b.kind === "image"
          ? { kind: "image" as const, media_type: b.media_type, data_base64: b.data_base64 }
          : { kind: "text" as const, text: b.text },
      ),
      max_tokens: req.max_tokens,
      tier: this.tier,
    };

    const resp = await fetch(`${this.apiBaseUrl}/v1/llm/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-machine-token": this.machineToken,
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      const data = (await resp.json().catch(() => ({}))) as { hourly_limit?: number };
      throw new Error(
        `${this.name}: rate-limited (hourly cap: ${data.hourly_limit ?? "?"}). Wait or set UNIVERSAL_BOT_MAX_LLM_CALLS=10 to bail sooner.`,
      );
    }
    if (resp.status === 503) {
      throw new Error(`${this.name}: proxy not configured server-side (503)`);
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`${this.name}: ${resp.status} ${text.slice(0, 300)}`);
    }

    const data = (await resp.json()) as {
      text: string;
      backend?: string;
      input_tokens?: number;
      output_tokens?: number;
    };
    return {
      text: data.text,
      backend: data.backend ?? this.name,
      ...(data.input_tokens !== undefined ? { input_tokens: data.input_tokens } : {}),
      ...(data.output_tokens !== undefined ? { output_tokens: data.output_tokens } : {}),
    };
  }
}

// ── Factory ──

export interface PickLLMClientOpts {
  // Override the model used by whichever backend wins. Mainly for the
  // OpenRouter "cheapest serviceable" case.
  preferCheap?: boolean;
}

// A pair of clients: a primary the agent uses for every call, plus an
// optional premium fallback the agent retries with when the primary's
// reply fails downstream validation (e.g. JSON parse). Premium is null
// when no premium-quality backend is available — the agent then surfaces
// the parse failure rather than retrying uselessly.
export interface LLMPair {
  primary: LLMClient;
  premium: LLMClient | null;
}

// "Cheapest serviceable" for our use case: needs vision + good JSON
// adherence + reasonable speed. Ordered by cost-per-1M-input tokens
// ascending (rates approximate, late-2025; OpenRouter updates daily,
// the relative order is what matters). Kept to exactly 3 entries:
// OpenRouter's `models` routing array caps at 3 (see OpenRouterClient),
// so a 4th would be silently dropped anyway. The previous list
// (gemini-flash-1.5*) was retired from OpenRouter — keep these current.
const CHEAP_VISION_MODELS_OR: string[] = [
  "google/gemini-2.0-flash-001", // ~$0.10/1M input — vision, fast, solid JSON
  "openai/gpt-4o-mini",          // ~$0.15/1M input — vision, excellent JSON
  "google/gemini-2.5-flash",     // ~$0.30/1M input — vision, strongest of the three
];

export function pickLLMClient(opts: PickLLMClientOpts = {}): LLMClient {
  return pickLLMPair(opts).primary;
}

// Returns both a primary client and an optional premium fallback. The
// agent uses this when it wants dual-tier: cheap-first, premium-only-on-
// validation-failure. Selection rules, in order:
//
//   1. TRUSTY_SQUIRE_MACHINE_TOKEN set (the default for MCP installs):
//        primary = ProxyLLMClient(cheap)  → /v1/llm/chat tier=cheap
//        premium = ProxyLLMClient(premium) when preferCheap=true
//      Operator pays for LLM; user pays nothing.
//
//   2. OPENROUTER_API_KEY set (BYOK):
//        primary = OpenRouter Gemini Flash (cheap) or Sonnet (default)
//        premium = OpenRouter Sonnet when preferCheap=true
//
//   3. ANTHROPIC_API_KEY set (BYOK):
//        primary = Anthropic direct (Sonnet)
//        premium = null
//
//   4. Else: throw.
//
// The Sonnet-via-OR premium routes through the same OpenRouter account
// the user already pays for, so they get one bill, not two.
export function pickLLMPair(opts: PickLLMClientOpts = {}): LLMPair {
  // 1. Trusty Squire proxy (default for MCP installs).
  const machineToken = process.env.TRUSTY_SQUIRE_MACHINE_TOKEN;
  if (machineToken !== undefined && machineToken.length > 0) {
    const apiBaseUrl =
      process.env.TRUSTY_SQUIRE_API_BASE ?? "https://trusty-squire-api.fly.dev";
    const primary = new ProxyLLMClient({ apiBaseUrl, machineToken, tier: "cheap" });
    const premium =
      opts.preferCheap === true
        ? new ProxyLLMClient({ apiBaseUrl, machineToken, tier: "premium" })
        : null;
    return { primary, premium };
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey !== undefined && orKey.length > 0) {
    if (opts.preferCheap === true) {
      const [primaryModel, ...fallbacks] = CHEAP_VISION_MODELS_OR;
      const primary = new OpenRouterClient({
        apiKey: orKey,
        ...(primaryModel !== undefined ? { model: primaryModel } : {}),
        fallbackModels: fallbacks,
      });
      // Premium fallback: Claude Sonnet via OR — only triggers on parse
      // failures, so amortized cost is small. (anthropic/claude-3.5-sonnet
      // was retired from OpenRouter; claude-sonnet-4.5 is the current id.)
      const premium = new OpenRouterClient({
        apiKey: orKey,
        model: "anthropic/claude-sonnet-4.5",
      });
      return { primary, premium };
    }
    return {
      primary: new OpenRouterClient({ apiKey: orKey }),
      premium: null,
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey !== undefined && anthropicKey.length > 0) {
    return {
      primary: new AnthropicDirectClient({
        apiKey: anthropicKey,
        ...(process.env.ANTHROPIC_MODEL !== undefined ? { model: process.env.ANTHROPIC_MODEL } : {}),
      }),
      premium: null,
    };
  }

  throw new Error(
    "No LLM backend available. Set OPENROUTER_API_KEY or ANTHROPIC_API_KEY before running the universal bot.",
  );
}
