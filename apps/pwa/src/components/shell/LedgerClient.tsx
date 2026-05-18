"use client";

import { useEffect, useState } from "react";
import { api, ApiClientError, type LedgerRow } from "@/lib/api-client";
import { formatCents } from "@/lib/mandate";

export function LedgerClient() {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.ledger();
        if (!cancelled) setRows(res.entries);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiClientError && err.status === 401
              ? "Sign in to view the ledger."
              : err instanceof Error
                ? err.message
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
  if (rows.length === 0) return <p className="text-[color:var(--color-text-soft)]">No entries yet.</p>;

  return (
    <table className="w-full text-sm">
      <thead className="text-left text-[color:var(--color-text-soft)] border-b border-[color:var(--color-border)]">
        <tr>
          <th className="py-2 pr-4 font-normal">When</th>
          <th className="py-2 pr-4 font-normal">Kind</th>
          <th className="py-2 pr-4 font-normal">Summary</th>
          <th className="py-2 pr-4 font-normal text-right">Amount</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="border-b border-[color:var(--color-border)]">
            <td className="py-2 pr-4 text-[color:var(--color-text-soft)]">
              {new Date(row.ts).toLocaleString()}
            </td>
            <td className="py-2 pr-4 font-mono text-xs">{row.kind}</td>
            <td className="py-2 pr-4">{row.summary}</td>
            <td className="py-2 pr-4 text-right">
              {row.amount_cents !== null ? formatCents(row.amount_cents) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
