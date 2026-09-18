// Platform Jev decisions — POST /v1/decide + GET /v1/usage.
//
// The API holds one TypeSafe key (TYPESAFE_API_KEY) and forwards the same
// body the MCP client already builds. Per-account usage is a ledger row,
// not a bill. See docs/DESIGN-jev-platform-route.md.

import { z } from "zod";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ApiDeps } from "../services/deps.js";
import { HttpProxyExecutor, ProxyError } from "../services/http-proxy.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const STATE_LIMIT_BYTES = 32 * 1024;
export const QUESTION_LIMIT = 12;
export const CRITERIA_LIMIT = 128;

const choiceQuestion = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string()),
});
const noulQuestion = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
});
const jevQuestion = z.discriminatedUnion("type", [choiceQuestion, noulQuestion]);
const decideBody = z.object({
  state: z.string(),
  questions: z.record(jevQuestion),
});

function typesafeApiKey(): string | null {
  const key = process.env.TYPESAFE_API_KEY;
  if (key === undefined || key.length === 0) return null;
  return key;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function usageFromBody(payload: unknown): {
  model: string;
  input_tokens: number;
  output_tokens: number;
} {
  if (typeof payload !== "object" || payload === null) {
    return { model: JEV_MODEL, input_tokens: 0, output_tokens: 0 };
  }
  const model = Reflect.get(payload, "model");
  const usage = Reflect.get(payload, "usage");
  const usageObj = typeof usage === "object" && usage !== null ? usage : null;
  return {
    model: typeof model === "string" && model.length > 0 ? model : JEV_MODEL,
    input_tokens: tokenCount(usageObj === null ? undefined : Reflect.get(usageObj, "input_tokens")),
    output_tokens: tokenCount(
      usageObj === null ? undefined : Reflect.get(usageObj, "output_tokens"),
    ),
  };
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

export const registerDecideRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  proxyExecutor?: HttpProxyExecutor;
}> = async (fastify, opts) => {
  const envMax = Number(process.env.VAULT_USE_MAX_RESPONSE_BYTES);
  const maxResponseBytes = Number.isFinite(envMax) && envMax > 0 ? envMax : 2 * 1024 * 1024;
  const executor = opts.proxyExecutor ?? new HttpProxyExecutor({ maxResponseBytes });

  fastify.post("/v1/decide", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const parsed = decideBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    if (Buffer.byteLength(data.state, "utf8") > STATE_LIMIT_BYTES) {
      reply.code(413).send({ error: "state_too_large", limit_bytes: STATE_LIMIT_BYTES });
      return;
    }
    const questionNames = Object.keys(data.questions);
    if (questionNames.length > QUESTION_LIMIT) {
      reply.code(413).send({ error: "too_many_questions", limit: QUESTION_LIMIT });
      return;
    }
    for (const question of Object.values(data.questions)) {
      if (question.type === "choice" && Object.keys(question.criteria).length > CRITERIA_LIMIT) {
        reply.code(413).send({ error: "too_many_criteria", limit: CRITERIA_LIMIT });
        return;
      }
    }

    const key = typesafeApiKey();
    if (key === null) {
      reply.code(503).send({ error: "jev_unconfigured" });
      return;
    }

    const started = Date.now();
    try {
      const response = await executor.execute({
        accountId: auth.account_id,
        http: {
          method: "POST",
          url: JEV_ENDPOINT,
          headers: {
            authorization: "Bearer ${SECRET}",
            "content-type": "application/json",
          },
          body: JSON.stringify({ state: data.state, model: JEV_MODEL, questions: data.questions }),
        },
        fields: { value: key },
      });
      const payload = parseJsonBody(response.body);
      const usage = usageFromBody(payload);
      try {
        await opts.deps.decisionEventStore.record({
          account_id: auth.account_id,
          occurred_at: opts.deps.now?.() ?? new Date(),
          model: usage.model,
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          upstream_status: response.status,
          latency_ms: Date.now() - started,
          questions: questionNames.length,
        });
      } catch (err) {
        req.log.warn({ err }, "decision ledger write failed");
      }
      return reply.code(response.status).send(payload);
    } catch (err) {
      if (err instanceof ProxyError && err.code === "timeout") {
        reply.code(504).send({ error: "jev_timeout" });
        return;
      }
      throw err;
    }
  });

  fastify.get("/v1/usage", { preHandler: opts.requireAgent }, async (req, reply) => {
    const auth = req.auth!;
    if (auth.kind !== "agent") return;
    const decisions = await opts.deps.decisionEventStore.monthUsage(
      auth.account_id,
      opts.deps.now?.() ?? new Date(),
    );
    return reply.code(200).send({ decisions });
  });
};
