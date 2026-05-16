// Captcha event store. One row per captcha encounter during a signup
// attempt, recorded by the MCP after the bot returns from a run.
//
// The whole point of this table: answer "are residential users
// actually unaffected, or do we have a wider captcha problem?" with
// data. Without it, the S1 (residential-proxy) decision is a vibes
// call. With it: a single SQL query tells us "of N captcha_blocked
// events last month, M were on datacenter networks" and we know
// whether the proxy work is worth doing.
//
// Why a dedicated table instead of stuffing this into LLMUsageEvent
// or a generic "events" table: the cardinality is very different
// (captchas are rare relative to LLM calls), the retention window is
// likely different (we'd want longer history on captcha events for
// trend analysis), and the query patterns are different (group-by
// asn_class is what matters here).

import type { ApiPrismaClient } from "./api-prisma-client.js";

export type CaptchaKindLabel = "turnstile" | "recaptcha" | "unknown";

export interface CaptchaEventRecord {
  service: string;
  captcha_kind: CaptchaKindLabel;
  blocked: boolean;
  // Whether the bot's browser egress went through the residential
  // proxy on this run. null = pre-0.1.8 client that didn't report it
  // (distinct from false = ran direct). Lets a query separate "proxy
  // didn't help" from "proxy never ran".
  proxied: boolean | null;
  // Spike telemetry (T3.2). null = pre-0.1.9 client. captcha_variant:
  // the captcha family; challenge_rendered: did an image-grid
  // challenge actually render; signup_succeeded: the run's ultimate
  // outcome — the number that says whether clearing a captcha leads
  // to a completed signup.
  captcha_variant: string | null;
  challenge_rendered: boolean | null;
  signup_succeeded: boolean | null;
  // The asn class of the machine when this event happened. Captured
  // at event time rather than read from MachineToken row at query
  // time because the machine might have moved networks since install
  // — the "where was I when this captcha hit me" is the analytically
  // interesting question.
  asn_class: string | null;
  asn_org: string | null;
  machine_token: string | null;
  occurred_at: Date;
}

export interface CaptchaEventStore {
  record(event: CaptchaEventRecord): Promise<void>;
}

// In-memory backing for tests + DB-less local dev. The events go
// nowhere but the API still accepts the POST cleanly, which is what
// matters for keeping the MCP path green.
export class InMemoryCaptchaEventStore implements CaptchaEventStore {
  readonly events: CaptchaEventRecord[] = [];
  async record(event: CaptchaEventRecord): Promise<void> {
    this.events.push(event);
  }
}

export class PrismaCaptchaEventStore implements CaptchaEventStore {
  constructor(private readonly prisma: ApiPrismaClient) {}
  async record(event: CaptchaEventRecord): Promise<void> {
    await this.prisma.captchaEvent.create({
      data: {
        service: event.service,
        captcha_kind: event.captcha_kind,
        blocked: event.blocked,
        proxied: event.proxied,
        captcha_variant: event.captcha_variant,
        challenge_rendered: event.challenge_rendered,
        signup_succeeded: event.signup_succeeded,
        asn_class: event.asn_class,
        asn_org: event.asn_org,
        machine_token: event.machine_token,
        occurred_at: event.occurred_at,
      },
    });
  }
}
