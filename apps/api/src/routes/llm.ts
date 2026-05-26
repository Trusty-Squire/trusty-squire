// LLM proxy for the universal signup bot.
//
// The bot runs on the user's machine but the LLM key lives here. The bot
// hits POST /v1/llm/chat with a machine token; we forward to OpenRouter
// (or Anthropic — whichever's configured) and return the reply.
//
// Why proxy instead of letting the bot use its own key?
//   1. the machine-token caller users haven't signed up for anything. We don't want to ask
//      them to BYOK an OpenRouter key just to use the free tier.
//   2. Server-side rate limiting protects us from a runaway bot loop
//      drilling our wallet. The per-signup cap inside the bot is best-
//      effort; this is the actual ceiling.
//   3. We can swap providers (OpenRouter → Anthropic → our own model)
//      without changing user machines.
//
// Wire format mirrors the universal-bot's LLMRequest interface
// intentionally — we keep the proxy boring so it can't accidentally
// become a general-purpose Anthropic-compatible endpoint.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authorizeMachineOrAdmin } from "../auth/authorize-machine-or-admin.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";
import type { LLMUsageTracker } from "../services/llm-usage-tracker.js";

const blockSchema = z.union([
  z.object({
    kind: z.literal("image"),
    // Both PNG and JPEG are valid for the multi-modal user blocks.
    // The bot's browser.screenshot() switched to JPEG (quality=70)
    // in rc.8 for ~10x smaller payloads + faster Claude tokenization;
    // some upstream call sites still emit PNG. Both pass through the
    // OpenRouter / Anthropic SDK unchanged.
    media_type: z.enum(["image/png", "image/jpeg"]),
    data_base64: z.string().min(1),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
  }),
]);

const chatBodySchema = z.object({
  system: z.string(),
  user: z.array(blockSchema).min(1).max(8),
  max_tokens: z.number().int().positive().max(8192),
  // Tier picks the model + fallback chain.
  //   cheap   — Gemini Flash class. Default for end-user signups.
  //   premium — GPT-4o class. Parse-failure retry path.
  //   free    — OpenRouter free-tier models with a paid escape-hatch.
  //             Used by the closed-loop verifier worker (no user is
  //             waiting; quality drops are tolerable; rate-limit
  //             failures auto-fall through to the paid escape).
  tier: z.enum(["cheap", "premium", "free"]).default("cheap"),
});

const CHEAP_MODEL = process.env.LLM_PROXY_CHEAP_MODEL ?? "google/gemini-flash-1.5";
// GPT-4o is the chosen premium fallback. It's strong on structured JSON
// (the primary failure mode that triggers premium retry), has solid
// vision, and is meaningfully cheaper per call than Sonnet 3.5 — around
// $2.50/$10 per M tokens vs Sonnet's $3/$15.
const PREMIUM_MODEL = process.env.LLM_PROXY_PREMIUM_MODEL ?? "openai/gpt-4o";

// Cheap-mode fallbacks (OpenRouter's "models" feature). When the primary
// is unavailable, OR transparently routes to the next entry.
//
// OpenRouter caps the `models` array at 3 total entries (primary +
// fallbacks). Keep the two highest-availability cheap models here so we
// stay under the cap.
const CHEAP_FALLBACKS = [
  "google/gemini-flash-1.5-8b",
  "openai/gpt-4o-mini",
];

// Free-tier chain. Designed for the closed-loop verifier worker —
// running fresh signups to validate captured skills before promoting
// them. The verifier is async + retriable, so the lower quality
// (worse JSON adherence on free models, weaker vision on subtle
// layouts) is acceptable. The chain ends in a PAID escape-hatch so
// transient free-tier rate-limits don't stall the worker entirely.
//
// All three slots are env-overridable. The defaults are the
// highest-availability free vision models on OpenRouter today; if
// names rotate (free tiers churn faster than paid), point the env at
// the new ids without a code change.
const FREE_MODEL = process.env.LLM_PROXY_FREE_MODEL ?? "google/gemini-2.0-flash-exp:free";
const FREE_FALLBACK_1 =
  process.env.LLM_PROXY_FREE_FALLBACK_1 ?? "meta-llama/llama-3.2-90b-vision-instruct:free";
// The paid escape kicks in only when both free models are unavailable.
// Default matches CHEAP_MODEL so the operator's worst-case cost still
// looks like a cheap-tier run, not a premium one.
const FREE_ESCAPE = process.env.LLM_PROXY_FREE_ESCAPE ?? "google/gemini-2.0-flash-001";

export interface LLMRouteDeps {
  machineTokenStore: MachineTokenStore;
  llmUsageTracker: LLMUsageTracker;
  now?: () => Date;
}

export async function registerLLMRoute(
  fastify: FastifyInstance,
  opts: { deps: LLMRouteDeps },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  if (orKey === "") {
    fastify.log.warn(
      "OPENROUTER_API_KEY not set — /v1/llm/chat will 503 on every request",
    );
  }

  fastify.post("/v1/llm/chat", async (req, reply) => {
    if (orKey === "") {
      reply.code(503).send({ error: "llm_proxy_not_configured" });
      return;
    }

    // Auth: machine token OR admin bearer. Shared with /v1/inbox/*.
    const principal = await authorizeMachineOrAdmin(req, reply, opts.deps.machineTokenStore);
    if (principal === null) return;

    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
      return;
    }

    // Per-machine-token rolling rate limit. Admin requests skip this so
    // we can do end-to-end tests without burning real quota.
    if (principal.kind === "machine") {
      if (!opts.deps.llmUsageTracker.shouldAllow(principal.token, now())) {
        reply.code(429).send({
          error: "llm_rate_limited",
          hourly_limit: opts.deps.llmUsageTracker.limit(),
          message:
            "Too many LLM calls in the last hour on this machine. " +
            "Either the bot is stuck in a planning loop, or you're hitting an unusual case. " +
            "If this is unexpected, set UNIVERSAL_BOT_MAX_LLM_CALLS=10 to make the bot bail sooner.",
        });
        return;
      }
      opts.deps.llmUsageTracker.record(principal.token, now());
    }

    // Translate our minimal block format → OpenAI chat-completions shape
    // (which OpenRouter speaks). Vision blocks become `image_url` with a
    // data: URI.
    const userContent = parsed.data.user.map((b) =>
      b.kind === "image"
        ? {
            type: "image_url" as const,
            image_url: { url: `data:${b.media_type};base64,${b.data_base64}` },
          }
        : { type: "text" as const, text: b.text },
    );

    const primaryModel =
      parsed.data.tier === "premium"
        ? PREMIUM_MODEL
        : parsed.data.tier === "free"
          ? FREE_MODEL
          : CHEAP_MODEL;
    const body: Record<string, unknown> = {
      model: primaryModel,
      max_tokens: parsed.data.max_tokens,
      messages: [
        { role: "system", content: parsed.data.system },
        { role: "user", content: userContent },
      ],
    };
    if (parsed.data.tier === "cheap" && CHEAP_FALLBACKS.length > 0) {
      body["models"] = [primaryModel, ...CHEAP_FALLBACKS];
    } else if (parsed.data.tier === "free") {
      // free → free → paid escape. OpenRouter caps at 3, which is
      // exactly what we want here.
      body["models"] = [FREE_MODEL, FREE_FALLBACK_1, FREE_ESCAPE];
    }

    try {
      const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${orKey}`,
          "HTTP-Referer": "https://trustysquire.ai",
          "X-Title": "Trusty Squire LLM Proxy",
        },
        body: JSON.stringify(body),
      });
      if (!orRes.ok) {
        const text = await orRes.text();
        fastify.log.warn({ status: orRes.status, body: text.slice(0, 500) }, "openrouter upstream error");
        reply.code(502).send({ error: "upstream_error", upstream_status: orRes.status });
        return;
      }
      const data = (await orRes.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const text = data.choices[0]?.message.content;
      if (typeof text !== "string") {
        reply.code(502).send({ error: "upstream_empty_reply" });
        return;
      }
      reply.send({
        text,
        backend: data.model !== undefined ? `proxy:${data.model}` : `proxy:${primaryModel}`,
        ...(data.usage?.prompt_tokens !== undefined ? { input_tokens: data.usage.prompt_tokens } : {}),
        ...(data.usage?.completion_tokens !== undefined ? { output_tokens: data.usage.completion_tokens } : {}),
      });
    } catch (err) {
      fastify.log.error({ err }, "llm proxy fetch failed");
      reply.code(502).send({ error: "upstream_unreachable" });
    }
  });
}
