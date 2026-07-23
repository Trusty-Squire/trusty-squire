import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";

const e2eBody = z.object({
  label: z.string().min(1).max(256),
  blob: z.string().min(1).max(8192),
});

const paymentAuditBody = z.object({
  merchant: z.string().min(1).max(256),
  amountCents: z.number().int(),
  currency: z.string().min(1).max(8),
  last4: z.string().regex(/^\d{4}$/),
  status: z.string().min(1).max(64),
  mandateId: z.string().max(128).optional(),
});

const paymentAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
});

export const registerVaultE2ERoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAny: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post(
    "/v1/vault/e2e",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const parsed = e2eBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const id = await opts.deps.e2eCredentialStore.create(
        auth.account_id,
        parsed.data.label,
        parsed.data.blob,
      );
      return reply.code(201).send({ id });
    },
  );

  fastify.get(
    "/v1/vault/e2e",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const records = await opts.deps.e2eCredentialStore.listByAccount(req.auth!.account_id);
      return reply.code(200).send(
        records.map((record) => ({
          id: record.id,
          label: record.label,
          createdAt: record.createdAt.toISOString(),
        })),
      );
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/v1/vault/e2e/:id",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const record = await opts.deps.e2eCredentialStore.getByIdForAccount(
        req.params.id,
        req.auth!.account_id,
      );
      if (record === null) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      return reply.code(200).send({
        id: record.id,
        label: record.label,
        blob: record.blob,
        createdAt: record.createdAt.toISOString(),
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/v1/vault/e2e/:id",
    { preHandler: opts.requireWeb },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "web") return;
      const deleted = await opts.deps.e2eCredentialStore.deleteForAccount(
        req.params.id,
        auth.account_id,
      );
      if (!deleted) {
        reply.code(404).send({ error: "credential_not_found" });
        return;
      }
      return reply.code(204).send();
    },
  );

  fastify.post(
    "/v1/vault/payments/audit",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const parsed = paymentAuditBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const id = await opts.deps.paymentAuditStore.create(auth.account_id, parsed.data);
      return reply.code(201).send({ id });
    },
  );

  fastify.get(
    "/v1/vault/payments/audit",
    { preHandler: opts.requireAny },
    async (req, reply) => {
      const parsed = paymentAuditQuery.safeParse(req.query);
      if (!parsed.success) {
        reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
        return;
      }
      const q = parsed.data;
      const records = await opts.deps.paymentAuditStore.listByAccount(
        req.auth!.account_id,
        {
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.before !== undefined ? { before: new Date(q.before) } : {}),
        },
      );
      const last = records.at(-1);
      return reply.code(200).send({
        events: records.map((record) => ({
          id: record.id,
          merchant: record.merchant,
          amountCents: record.amountCents,
          currency: record.currency,
          last4: record.last4,
          status: record.status,
          mandateId: record.mandateId,
          createdAt: record.createdAt.toISOString(),
        })),
        next_before:
          records.length === (q.limit ?? 50) && last !== undefined
            ? last.createdAt.toISOString()
            : null,
      });
    },
  );
};
