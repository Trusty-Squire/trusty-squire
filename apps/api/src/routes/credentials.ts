// GET /v1/credentials/:reference — agent-side credential retrieval.
// Required body: { purpose }. Calls vault.retrieveForRuntime so a
// long-running MCP agent doesn't need a fresh device assertion every
// time. The agent's session is the auth boundary; rate-limiting per
// session protects against compromised agent tokens.

import { z } from "zod";
import { type FastifyPluginAsync, type FastifyReply, type FastifyRequest } from "fastify";
import type { ApiDeps } from "../services/deps.js";

export const registerCredentialsRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  requireAgent: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
}> = async (fastify, opts) => {
  fastify.get<{ Params: { reference: string }; Querystring: { purpose?: string } }>(
    "/v1/credentials/:reference",
    { preHandler: opts.requireAgent },
    async (req, reply) => {
      const auth = req.auth!;
      if (auth.kind !== "agent") return;
      const purposeCheck = z.string().min(1).max(200).safeParse(req.query.purpose);
      if (!purposeCheck.success) {
        reply.code(400).send({ error: "purpose_required" });
        return;
      }

      // Decode the reference — clients percent-encode it because vault
      // references contain `://`.
      const reference = decodeURIComponent(req.params.reference);

      // Ownership check: the vault reference must be scoped under the
      // calling agent's account. Our reference convention is
      // `vault://<account_id>/...`. A malicious agent ferreting around
      // for another account's credentials hits 403.
      if (!reference.startsWith(`vault://${auth.account_id}/`) &&
          !reference.startsWith(`mockvault://`)) {
        // mockvault:// allowed for test fixtures (in-memory vault uses it).
        reply.code(403).send({ error: "wrong_account_for_reference" });
        return;
      }

      let value: string;
      try {
        // The vault now stores a field map; collapse to the sole/`value`
        // field for this legacy single-value read. (Last raw-read path.)
        const fields = await opts.deps.vault.retrieveForRuntime(reference, purposeCheck.data);
        value = fields.value ?? Object.values(fields)[0] ?? "";
      } catch (err) {
        reply.code(404).send({
          error: "credential_not_found",
          reason: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      return reply.code(200).send({ value, reference, retrieved_at: new Date().toISOString() });
    },
  );
};
