// Decision event store. One row per platform Jev call (POST /v1/decide),
// recorded after the upstream reply so /v1/usage can sum the month.
// Best-effort: a write failure is the caller's to swallow, never the
// decision response. See docs/DESIGN-jev-platform-route.md.

import type { ApiPrismaClient } from "./api-prisma-client.js";

export interface DecisionEventRecord {
  account_id: string;
  occurred_at: Date;
  model: string;
  input_tokens: number;
  output_tokens: number;
  upstream_status: number;
  latency_ms: number;
  questions: number;
}

export interface DecisionMonthUsage {
  month_calls: number;
  month_input_tokens: number;
  month_output_tokens: number;
}

export interface DecisionEventStore {
  record(event: DecisionEventRecord): Promise<void>;
  monthUsage(accountId: string, now: Date): Promise<DecisionMonthUsage>;
}

export function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function sumMonth(events: DecisionEventRecord[], accountId: string, now: Date): DecisionMonthUsage {
  const start = startOfUtcMonth(now);
  let month_calls = 0;
  let month_input_tokens = 0;
  let month_output_tokens = 0;
  for (const event of events) {
    if (event.account_id !== accountId || event.occurred_at < start) continue;
    month_calls += 1;
    month_input_tokens += event.input_tokens;
    month_output_tokens += event.output_tokens;
  }
  return { month_calls, month_input_tokens, month_output_tokens };
}

export class InMemoryDecisionEventStore implements DecisionEventStore {
  readonly events: DecisionEventRecord[] = [];
  async record(event: DecisionEventRecord): Promise<void> {
    this.events.push(event);
  }
  async monthUsage(accountId: string, now: Date): Promise<DecisionMonthUsage> {
    return sumMonth(this.events, accountId, now);
  }
}

export class PrismaDecisionEventStore implements DecisionEventStore {
  constructor(private readonly prisma: ApiPrismaClient) {}
  async record(event: DecisionEventRecord): Promise<void> {
    await this.prisma.decisionEvent.create({
      data: {
        account_id: event.account_id,
        occurred_at: event.occurred_at,
        model: event.model,
        input_tokens: event.input_tokens,
        output_tokens: event.output_tokens,
        upstream_status: event.upstream_status,
        latency_ms: event.latency_ms,
        questions: event.questions,
      },
    });
  }
  async monthUsage(accountId: string, now: Date): Promise<DecisionMonthUsage> {
    const rows = await this.prisma.decisionEvent.findMany({
      where: { account_id: accountId, occurred_at: { gte: startOfUtcMonth(now) } },
      select: { input_tokens: true, output_tokens: true },
    });
    let month_input_tokens = 0;
    let month_output_tokens = 0;
    for (const row of rows) {
      month_input_tokens += row.input_tokens;
      month_output_tokens += row.output_tokens;
    }
    return { month_calls: rows.length, month_input_tokens, month_output_tokens };
  }
}
