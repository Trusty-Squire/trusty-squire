// POST /v1/vouchflow/devices — a signed-in browser claims its enrolled
// Vouchflow signing device for the account it is signed in as.
//
// This is the one place the account→device link is established, and it is
// deliberately the ONLY endpoint in the approval story that still wants a web
// session: the ceremonies themselves are sessionless, so the binding they
// check has to have been made somewhere a session proved who the human is.

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../services/deps.js";

const registerBody = z
  .object({
    device_token: z
      .string()
      .min(8)
      .max(256)
      .regex(/^[A-Za-z0-9_.:-]+$/),
  })
  .strict();

export const registerVouchflowDeviceRoutes: FastifyPluginAsync<{
  deps: ApiDeps;
  requireWeb: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.post("/v1/vouchflow/devices", { preHandler: opts.requireWeb }, async (req, reply) => {
    const parsed = registerBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const now = opts.deps.now?.() ?? new Date();
    await opts.deps.vouchflowDeviceStore.register(
      req.auth!.account_id,
      parsed.data.device_token,
      now,
    );
    return reply.code(204).send();
  });
};
