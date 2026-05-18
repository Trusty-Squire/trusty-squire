"use client";

import { useEffect, useState } from "react";
import { api, ApiClientError, type LedgerRow, type SubscriptionRow, type UsageResponse } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatCents } from "@/lib/mandate";

type DashState =
  | { kind: "loading" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string }
  | { kind: "ready"; usage: UsageResponse; subs: SubscriptionRow[]; ledger: LedgerRow[] };

export function DashboardClient() {
  const [state, setState] = useState<DashState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [usage, subs, ledger] = await Promise.all([api.usage(), api.subscriptions(), api.ledger()]);
        if (!cancelled) {
          setState({ kind: "ready", usage, subs: subs.subscriptions, ledger: ledger.entries.slice(0, 5) });
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 401) {
          setState({ kind: "unauthenticated" });
        } else {
          setState({ kind: "error", message: err instanceof Error ? err.message : "Failed to load." });
        }
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return <p className="text-[color:var(--color-text-soft)]">Loading…</p>;
  if (state.kind === "unauthenticated") {
    return (
      <p>
        <a href="/login">Sign in</a> to view your dashboard.
      </p>
    );
  }
  if (state.kind === "error") {
    return <p className="text-[color:var(--color-accent)]">Failed to load dashboard: {state.message}</p>;
  }

  const { usage, subs, ledger } = state;
  const pct = usage.budget_cents > 0 ? Math.min(100, (usage.total_spend_cents / usage.budget_cents) * 100) : 0;

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <Card className="md:col-span-2">
        <h2 className="text-xl mb-3">Spending this month</h2>
        <div className="flex items-baseline gap-3">
          <span className="text-3xl text-[color:var(--color-accent)]">{formatCents(usage.total_spend_cents)}</span>
          <span className="text-[color:var(--color-text-soft)]">of {formatCents(usage.budget_cents)} budget</span>
        </div>
        <div className="mt-3 h-2 rounded bg-[color:var(--color-surface-raised)] overflow-hidden">
          <div
            className="h-full bg-[color:var(--color-accent)]"
            style={{ width: `${pct}%` }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          />
        </div>
        {usage.by_category.length > 0 ? (
          <ul className="mt-4 text-sm space-y-1">
            {usage.by_category.map((c) => (
              <li key={c.category} className="flex justify-between">
                <span className="text-[color:var(--color-text-soft)]">{c.category}</span>
                <span>{formatCents(c.spend_cents)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card>
        <h2 className="text-xl mb-3">Active subscriptions</h2>
        {subs.length === 0 ? (
          <p className="text-[color:var(--color-text-soft)] text-sm">None yet. Your squire will sign up as needed.</p>
        ) : (
          <ul className="space-y-2">
            {subs.map((s) => (
              <li key={s.id} className="flex justify-between text-sm">
                <span>{s.service_name}</span>
                <span className="text-[color:var(--color-text-soft)]">
                  {s.monthly_cost_cents !== null ? `${formatCents(s.monthly_cost_cents)}/mo` : "free"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-xl mb-3">Recent activity</h2>
        {ledger.length === 0 ? (
          <p className="text-[color:var(--color-text-soft)] text-sm">Nothing yet.</p>
        ) : (
          <ul className="space-y-2">
            {ledger.map((row) => (
              <li key={row.id} className="text-sm">
                <span className="text-[color:var(--color-text-soft)] mr-2">
                  {new Date(row.ts).toLocaleDateString()}
                </span>
                <span>{row.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
