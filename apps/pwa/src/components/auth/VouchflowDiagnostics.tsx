"use client";

import { useState } from "react";
import { getVouchflowDiagnostics, type VouchflowCallLog } from "@/lib/vouchflow";

interface Props {
  err: unknown;
}

// Renders the Vouchflow network capture attached to a thrown error.
// On mobile this is the only practical way to inspect the request/
// response chain that caused a ceremony to fail (no DevTools).

export function VouchflowDiagnostics({ err }: Props) {
  const log = getVouchflowDiagnostics(err);
  const [expanded, setExpanded] = useState<number | null>(log !== null && log.length > 0 ? log.length - 1 : null);
  if (log === null || log.length === 0) return null;

  return (
    <details className="text-xs border border-[color:var(--color-rule)] rounded-md bg-[color:var(--color-cream)] p-2" open>
      <summary className="cursor-pointer font-medium text-[color:var(--color-amber-black)]">
        Vouchflow request log ({log.length} call{log.length === 1 ? "" : "s"})
      </summary>
      <ol className="mt-2 space-y-2 font-mono">
        {log.map((entry, i) => (
          <li key={i} className="border-t border-[color:var(--color-rule)] pt-2">
            <button
              type="button"
              className="text-left w-full"
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <span className={entry.status >= 400 || entry.status === 0 ? "text-[color:var(--color-wine)]" : ""}>
                [{entry.status || "ERR"}] {entry.method} {shortPath(entry.url)} <span className="text-[color:var(--color-ink-muted)]">({entry.duration_ms}ms)</span>
              </span>
            </button>
            {expanded === i ? (
              <div className="mt-1 space-y-1">
                <div className="text-[color:var(--color-ink-soft)]">URL: {entry.url}</div>
                {entry.request_body !== null ? (
                  <pre className="whitespace-pre-wrap break-all bg-white p-1 rounded border border-[color:var(--color-rule)]">
                    → {truncatePretty(entry.request_body)}
                  </pre>
                ) : null}
                <pre className="whitespace-pre-wrap break-all bg-white p-1 rounded border border-[color:var(--color-rule)]">
                  ← {truncatePretty(entry.response_body)}
                </pre>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function shortPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function truncatePretty(s: string): string {
  // Try to pretty-print JSON if possible.
  try {
    const parsed = JSON.parse(s) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

export type { VouchflowCallLog };
