"use client";

import { useState } from "react";
import {
  forgetDevice,
  getVouchflowDiagnostics,
  isLikelyDeviceDesync,
  type VouchflowCallLog,
} from "@/lib/vouchflow";

interface Props {
  err: unknown;
  // When provided, the "Reset and retry" button calls this after
  // forgetDevice() so the page can immediately re-attempt the
  // ceremony without making the user click the original submit
  // button again.
  onRetry?: () => void;
}

// Renders the Vouchflow network capture attached to a thrown error.
// On mobile this is the only practical way to inspect the request/
// response chain that caused a ceremony to fail (no DevTools).
//
// Also surfaces a "Reset device state" button when the error pattern
// suggests platform-authenticator / SDK desync — one tap instead of
// digging through Chrome's site-data clearer.

export function VouchflowDiagnostics({ err, onRetry }: Props) {
  const log = getVouchflowDiagnostics(err);
  const showResetButton = isLikelyDeviceDesync(err);
  const [resetting, setResetting] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(
    log !== null && log.length > 0 ? log.length - 1 : null,
  );

  async function doReset(): Promise<void> {
    setResetting(true);
    setResetMsg(null);
    try {
      await forgetDevice();
      setResetMsg("Device state cleared. Try again.");
      onRetry?.();
    } catch (resetErr) {
      setResetMsg(`Reset failed: ${resetErr instanceof Error ? resetErr.message : String(resetErr)}`);
    } finally {
      setResetting(false);
    }
  }

  if (log === null || log.length === 0) {
    if (!showResetButton) return null;
    return (
      <ResetButton resetting={resetting} resetMsg={resetMsg} onClick={doReset} />
    );
  }

  return (
    <div className="space-y-2">
      {showResetButton ? (
        <ResetButton resetting={resetting} resetMsg={resetMsg} onClick={doReset} />
      ) : null}
      <details
        className="text-xs border border-[color:var(--color-rule)] rounded-md bg-[color:var(--color-cream)] p-2"
        open
      >
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
                <span
                  className={
                    entry.status >= 400 || entry.status === 0 ? "text-[color:var(--color-wine)]" : ""
                  }
                >
                  [{entry.status || "ERR"}] {entry.method} {shortPath(entry.url)}{" "}
                  <span className="text-[color:var(--color-ink-muted)]">({entry.duration_ms}ms)</span>
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
    </div>
  );
}

function ResetButton({
  resetting,
  resetMsg,
  onClick,
}: {
  resetting: boolean;
  resetMsg: string | null;
  onClick: () => void;
}) {
  return (
    <div className="space-y-1 border border-[color:var(--color-rule)] rounded-md bg-[color:var(--color-cream)] p-2">
      <p className="text-xs text-[color:var(--color-ink-soft)]">
        Looks like the SDK and your device authenticator disagree about whether you're enrolled.
        Clearing the SDK's local state will trigger a fresh passkey setup on the next try.
      </p>
      <button
        type="button"
        onClick={onClick}
        disabled={resetting}
        className="text-xs px-3 py-1.5 rounded border border-[color:var(--color-wine)] text-[color:var(--color-wine)] bg-white disabled:opacity-50"
      >
        {resetting ? "Clearing…" : "Reset device state"}
      </button>
      {resetMsg !== null ? (
        <p className="text-xs text-[color:var(--color-ink-soft)]">{resetMsg}</p>
      ) : null}
    </div>
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
  try {
    const parsed = JSON.parse(s) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

export type { VouchflowCallLog };
