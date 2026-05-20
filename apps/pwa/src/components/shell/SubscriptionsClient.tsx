"use client";

import { useEffect, useState } from "react";
import { api, ApiClientError, type SubscriptionRow } from "@/lib/api-client";
import { formatCents } from "@/lib/mandate";

export function SubscriptionsClient() {
  const [rows, setRows] = useState<SubscriptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.subscriptions();
        if (!cancelled) setRows(res.subscriptions);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError && err.status === 401
              ? "Sign in to view subscriptions."
              : "Failed to load.",
          );
        }
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) return <p className="text-[color:var(--color-accent)]">{error}</p>;
  if (rows === null) return <p className="text-[color:var(--color-text-soft)]">Loading…</p>;
  if (rows.length === 0)
    return <p className="text-[color:var(--color-text-soft)]">No subscriptions yet.</p>;

  return (
    <ul className="divide-y divide-[color:var(--color-border)]">
      {rows.map((row) => (
        <li key={row.id} className="py-4 flex items-center justify-between">
          <div>
            <p className="font-medium">{row.service_name}</p>
            <p className="text-xs text-[color:var(--color-text-soft)] font-mono">{row.service_reference}</p>
          </div>
          <div className="text-right">
            <p className="text-sm">{row.monthly_cost_cents !== null ? `${formatCents(row.monthly_cost_cents)}/mo` : "free"}</p>
            <p className="text-xs text-[color:var(--color-text-soft)]">{row.status}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}
