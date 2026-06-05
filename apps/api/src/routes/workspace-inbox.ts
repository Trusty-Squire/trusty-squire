// POST /v1/inbox/poll-workspace-mail — IMAP-backed signup
// verification fetch for Workspace catch-all aliases
// (`<random>@trustysquire.ai` → lunchbox@trustysquire.ai).
//
// Same auth shape as poll-operator-otp: machine-token bearer.
// Returns the first email matching the requested `to_address` in
// the last `since_seconds`, with body + parsed links so the bot can
// click the verification URL. Returns null on miss.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { extractMachineToken } from "./install.js";
import {
  WorkspaceInboxPoller,
  type WorkspacePollInput,
  type WorkspacePollResult,
} from "../services/workspace-inbox-poller.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";

export interface WorkspaceInboxRouteDeps {
  machineTokenStore: MachineTokenStore;
}

export async function registerWorkspaceInboxRoute(
  fastify: FastifyInstance,
  opts: { deps: WorkspaceInboxRouteDeps },
): Promise<void> {
  fastify.post("/v1/inbox/poll-workspace-mail", async (req, reply) => {
    const token = extractMachineToken(req);
    if (token === null) {
      reply.code(401).send({ error: "missing_machine_token" });
      return;
    }
    const tokenRow = await opts.deps.machineTokenStore.find(token);
    if (tokenRow === null) {
      reply.code(401).send({ error: "invalid_machine_token" });
      return;
    }

    const cfg = readImapConfig();
    if (cfg === null) {
      reply.code(503).send({
        email: null,
        reason: "workspace_imap_not_configured",
        scanned: 0,
      } satisfies WorkspacePollResult);
      return;
    }

    const input = parseBody(req);
    if (input === null) {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }

    const poller = new WorkspaceInboxPoller(cfg);
    const result = await poller.poll(input);
    // Diagnostic: when no mail was found AND the alias domain differs
    // from the mailbox the poller is actually reading, the workspace IMAP
    // is almost certainly mis-pointed — WORKSPACE_IMAP_USER is unset so
    // the poll fell back to GMAIL_USER (the OTP poller's personal gmail),
    // which never receives the alias-domain catch-all. Surface it in the
    // reason so the operator sees the misconfig in the bot's step trail
    // instead of a silent "no_recent_messages".
    if (result.email === null) {
      const aliasDomain = input.to_address.split("@")[1]?.toLowerCase() ?? "";
      const mailboxDomain = cfg.imapUser.split("@")[1]?.toLowerCase() ?? "";
      if (aliasDomain !== "" && mailboxDomain !== "" && aliasDomain !== mailboxDomain) {
        reply.code(200).send({
          ...result,
          reason:
            `mailbox_domain_mismatch: polling @${mailboxDomain} but the alias is ` +
            `@${aliasDomain} — set WORKSPACE_IMAP_USER to the @${aliasDomain} mailbox`,
        } satisfies WorkspacePollResult);
        return;
      }
    }
    reply.code(200).send(result);
  });
}

// Workspace IMAP credentials. Reuses GMAIL_USER/GMAIL_APP_PASSWORD
// when those are pointing at a Workspace mailbox (Workspace IMAP is
// served by imap.gmail.com), so a single env switch on the API
// (`GMAIL_USER=lunchbox@trustysquire.ai` plus the matching Workspace
// app password) covers both pollers. An optional dedicated pair
// (`WORKSPACE_IMAP_USER` / `WORKSPACE_IMAP_PASSWORD`) takes
// precedence when set — useful when the two paths need different
// accounts.
function readImapConfig(): { imapUser: string; imapAppPassword: string } | null {
  const u =
    process.env.WORKSPACE_IMAP_USER ?? process.env.GMAIL_USER;
  const p =
    process.env.WORKSPACE_IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
  if (typeof u !== "string" || u.length === 0) return null;
  if (typeof p !== "string" || p.length === 0) return null;
  return { imapUser: u, imapAppPassword: p };
}

function parseBody(req: FastifyRequest): WorkspacePollInput | null {
  const b = req.body;
  if (b === null || typeof b !== "object") return null;
  const obj = b as Record<string, unknown>;
  const to = obj["to_address"];
  if (typeof to !== "string" || to.length === 0 || !to.includes("@")) return null;
  const sinceRaw = obj["since_seconds"];
  const since =
    typeof sinceRaw === "number" && Number.isFinite(sinceRaw)
      ? Math.floor(sinceRaw)
      : 90;
  return { to_address: to, since_seconds: since };
}
