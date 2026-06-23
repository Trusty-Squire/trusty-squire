// HTTP routes for ExtractFailureSnapshot uploads/reads.
//
//   POST /v1/extract-failures           — upload a snapshot (bot)
//   GET  /v1/extract-failures           — list mine (CLI diagnostic)
//   GET  /v1/extract-failures/:id       — fetch one (CLI diagnostic)
//   GET  /v1/extract-failures/:id/html  — raw HTML body (browser-openable)
//   GET  /v1/extract-failures/:id/jpeg  — raw JPEG bytes
//
// Account scoping: `resolveAccountId` extracts the account from auth
// headers (production: JWT; tests + dev: x-account-id header). Every
// read is scoped to that account; no cross-account access.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  type ExtractFailureStore,
  type ExtractFailureDetail,
  type ExtractFailureSummary,
  RateLimitedError,
  TooLargeError,
} from "../extract-failure-store.js";
import { redactCredentials, redactHtml } from "../redact.js";

export interface ExtractFailuresRouteDeps {
  store: ExtractFailureStore;
  resolveAccountId: (req: { headers: Record<string, unknown> }) => string;
}

const UploadBodySchema = z.object({
  service: z.string().min(1).max(80),
  mcp_version: z.string().min(1).max(40),
  url: z.string().min(1).max(2048),
  title: z.string().max(512),
  step_label: z.string().min(1).max(512),
  extract_reason: z.string().max(4000),
  candidates: z.array(z.string()).max(200).default([]),
  // The bot sends the raw HTML string. Server compresses.
  html: z.string().min(1),
  // Optional JPEG, base64 encoded.
  screenshot_jpeg_base64: z.string().optional(),
  // T45 — correlation id linking this snapshot to a ProvisionAttempt
  // row uploaded from the same provision run. The MCP
  // generates a fresh provision_id per run; older clients omit this
  // field and the snapshot stays unlinked.
  provision_id: z.string().min(1).max(120).optional(),
});

export const registerExtractFailuresRoute: FastifyPluginAsync<ExtractFailuresRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  const { store, resolveAccountId } = opts;

  fastify.post("/v1/extract-failures", async (request, reply) => {
    const parsed = UploadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", details: parsed.error.format() });
    }
    const account_id = resolveAccountId(request);
    try {
      const { screenshot_jpeg_base64, provision_id, ...payload } = parsed.data;
      const upload = {
        ...payload,
        extract_reason: redactCredentials(payload.extract_reason),
        candidates: payload.candidates.map(redactCredentials),
        html: redactHtml(payload.html),
        ...(screenshot_jpeg_base64 !== undefined ? { screenshot_jpeg_base64 } : {}),
        ...(provision_id !== undefined ? { provision_id } : {}),
      };
      const summary = await store.upload(account_id, upload);
      return reply.code(201).send(sanitizeSummary(summary));
    } catch (err) {
      if (err instanceof RateLimitedError) {
        return reply
          .code(429)
          .header("Retry-After", String(err.retry_after_seconds))
          .send({ error: "rate_limited", retry_after_seconds: err.retry_after_seconds });
      }
      if (err instanceof TooLargeError) {
        return reply.code(413).send({ error: "payload_too_large", field: err.field, bytes: err.bytes });
      }
      fastify.log.error(err, "extract-failure upload failed");
      return reply.code(500).send({ error: "internal" });
    }
  });

  fastify.get("/v1/extract-failures", async (request, reply) => {
    const account_id = resolveAccountId(request);
    const query = request.query as Record<string, string | undefined>;
    const limit = query.limit !== undefined ? Math.min(200, Math.max(1, Number(query.limit))) : 50;
    const summaries = await store.list(account_id, limit);
    return reply.send({ snapshots: summaries.map(sanitizeSummary) });
  });

  fastify.get("/v1/extract-failures/:id", async (request, reply) => {
    const account_id = resolveAccountId(request);
    const { id } = request.params as { id: string };
    const detail = await store.get(account_id, id);
    if (detail === null) return reply.code(404).send({ error: "not_found" });
    return reply.send({
      ...sanitizeDetail(detail),
      screenshot_jpeg_base64:
        detail.screenshot_jpeg !== null
          ? detail.screenshot_jpeg.toString("base64")
          : null,
      // Don't double-send the binary; the dedicated endpoints below
      // serve the raw bytes for tooling that wants to redirect a
      // browser at them.
      screenshot_jpeg: undefined,
    });
  });

  // Convenience: open the failed page's HTML in a browser tab.
  fastify.get("/v1/extract-failures/:id/html", async (request, reply) => {
    const account_id = resolveAccountId(request);
    const { id } = request.params as { id: string };
    const detail = await store.get(account_id, id);
    if (detail === null) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("Content-Type", "text/html; charset=utf-8")
      .send(redactHtml(detail.html));
  });

  fastify.get("/v1/extract-failures/:id/jpeg", async (request, reply) => {
    const account_id = resolveAccountId(request);
    const { id } = request.params as { id: string };
    const detail = await store.get(account_id, id);
    if (detail === null) return reply.code(404).send({ error: "not_found" });
    if (detail.screenshot_jpeg === null) return reply.code(404).send({ error: "no_screenshot" });
    return reply
      .header("Content-Type", "image/jpeg")
      .send(detail.screenshot_jpeg);
  });
};

function sanitizeSummary(summary: ExtractFailureSummary): ExtractFailureSummary {
  return {
    ...summary,
    extract_reason: redactCredentials(summary.extract_reason),
  };
}

function sanitizeDetail(detail: ExtractFailureDetail): ExtractFailureDetail {
  return {
    ...sanitizeSummary(detail),
    html: redactHtml(detail.html),
    screenshot_jpeg: detail.screenshot_jpeg,
    candidates: detail.candidates.map(redactCredentials),
  };
}
