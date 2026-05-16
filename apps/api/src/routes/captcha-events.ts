// Captcha-event ingest route. The MCP `provision_any_service` tool POSTs
// here whenever a signup attempt encounters a captcha (whether the bot
// escaped it or got blocked). The events feed the analytics that
// decide whether residential-proxy work is worth doing.
//
// Auth: machine-token-only. We don't want anonymous public writes
// (someone could spam the table to bias the analytics), but we also
// don't want a separate auth scheme — the MCP already carries the
// machine token, this is the same trust level as /v1/install/status.
//
// Validation: tight enough to keep junk out of the table, loose
// enough that a slightly-newer or slightly-older client doesn't get
// rejected. Unknown captcha_kind values get normalized to "unknown".

import type { FastifyInstance } from "fastify";
import { extractMachineToken } from "./install.js";
import type { CaptchaEventStore } from "../services/captcha-events.js";
import type { MachineTokenStore } from "../services/machine-tokens.js";

export interface CaptchaEventsRouteDeps {
  captchaEventStore: CaptchaEventStore;
  machineTokenStore: MachineTokenStore;
  now?: () => Date;
}

export async function registerCaptchaEventsRoute(
  fastify: FastifyInstance,
  opts: { deps: CaptchaEventsRouteDeps },
): Promise<void> {
  const now = (): Date => opts.deps.now?.() ?? new Date();

  fastify.post("/v1/captcha-events", async (req, reply) => {
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

    const body = req.body;
    if (body === null || typeof body !== "object") {
      reply.code(400).send({ error: "invalid_body" });
      return;
    }
    const b = body as Record<string, unknown>;

    const service = typeof b.service === "string" && b.service.length > 0 ? b.service : null;
    if (service === null) {
      reply.code(400).send({ error: "missing_service" });
      return;
    }

    // Normalize captcha kind. Unknown labels still get persisted (as
    // "unknown") so we don't lose the event over a label mismatch —
    // we *will* notice it in queries because grouping by kind will
    // surface anything ill-named.
    const rawKind = b.captcha_kind;
    const captchaKind =
      rawKind === "turnstile" || rawKind === "recaptcha" ? rawKind : "unknown";

    const blocked = b.blocked === true;

    // Whether the bot's browser egress went through the residential
    // proxy on this run. Optional — pre-0.1.8 clients don't send it,
    // so absence is stored as null ("unknown"), distinct from false
    // ("ran direct"). This is the field that tells a query apart
    // "proxy ran and the captcha still fired" from "proxy never ran".
    const proxied = typeof b.proxied === "boolean" ? b.proxied : null;

    // Spike telemetry (T3.2). All optional — a pre-0.1.9 client omits
    // them and they record as null. captcha_variant is allowlisted
    // (same posture as captcha_kind); an unrecognized string is
    // normalized to "unknown" so a label mismatch never loses the row.
    const captchaVariants = [
      "recaptcha_v2",
      "recaptcha_v3",
      "turnstile",
      "hcaptcha",
      "unknown",
    ];
    const captchaVariant =
      typeof b.captcha_variant === "string"
        ? captchaVariants.includes(b.captcha_variant)
          ? b.captcha_variant
          : "unknown"
        : null;
    const challengeRendered =
      typeof b.challenge_rendered === "boolean" ? b.challenge_rendered : null;
    const signupSucceeded =
      typeof b.signup_succeeded === "boolean" ? b.signup_succeeded : null;

    // Prefer the asn captured at event time (richer signal — the user
    // may have moved networks since install) but fall back to the
    // install-time asn from the MachineToken row so we always have
    // *some* class to group by.
    const eventAsn = b.asn;
    let asnClass: string | null = null;
    let asnOrg: string | null = null;
    if (eventAsn !== null && typeof eventAsn === "object") {
      const a = eventAsn as Record<string, unknown>;
      if (
        a.class === "residential" ||
        a.class === "datacenter" ||
        a.class === "unknown"
      ) {
        asnClass = a.class;
      }
      if (typeof a.org === "string") asnOrg = a.org;
    }
    if (asnClass === null && tokenRow.asn !== null) {
      asnClass = tokenRow.asn.class;
      asnOrg = tokenRow.asn.org;
    }

    await opts.deps.captchaEventStore.record({
      service,
      captcha_kind: captchaKind,
      blocked,
      proxied,
      captcha_variant: captchaVariant,
      challenge_rendered: challengeRendered,
      signup_succeeded: signupSucceeded,
      asn_class: asnClass,
      asn_org: asnOrg,
      machine_token: tokenRow.token,
      occurred_at: now(),
    });

    reply.code(202).send({ recorded: true });
  });
}
