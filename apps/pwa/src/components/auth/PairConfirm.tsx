"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { signPayload, isVouchflowError } from "@/lib/vouchflow";
import { api, ApiClientError, apiBaseUrl } from "@/lib/api-client";

const AGENT_DISPLAY: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  goose: "Goose",
  cline: "Cline",
  continue: "Continue",
};

type PairStatus =
  | { kind: "loading" }
  | { kind: "ready"; agent: string | null }
  | { kind: "expired" }
  | { kind: "not_found" }
  | { kind: "done" };

interface PairConfirmProps {
  token: string;
  email: string;
}

export function PairConfirm({ token, email }: PairConfirmProps) {
  const [status, setStatus] = useState<PairStatus>({ kind: "loading" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/v1/mcp/pair/${encodeURIComponent(token)}/status`);
        if (cancelled) return;
        if (res.status === 404) {
          setStatus({ kind: "not_found" });
          return;
        }
        if (res.status === 410) {
          setStatus({ kind: "expired" });
          return;
        }
        const body = (await res.json()) as { status: string; agent_identity?: string | null };
        if (body.status === "pending") {
          setStatus({ kind: "ready", agent: body.agent_identity ?? null });
        } else {
          setStatus({ kind: "expired" });
        }
      } catch {
        if (!cancelled) setStatus({ kind: "expired" });
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onConfirm() {
    if (status.kind !== "ready") return;
    setPending(true);
    setError(null);
    try {
      const bundle = await signPayload({
        context: "mcp_pair",
        payload: { pair_token: token, agent_identity: status.agent ?? null },
        userHandle: email,
        minConfidence: "medium",
      });
      await api.claimPair(token, bundle, status.agent ?? "unknown", null);
      setStatus({ kind: "done" });
    } catch (err) {
      setError(
        isVouchflowError(err)
          ? `Pairing failed: ${err.code}`
          : err instanceof ApiClientError
            ? `Server rejected: ${err.status}`
            : "Pairing failed.",
      );
    } finally {
      setPending(false);
    }
  }

  if (status.kind === "loading") {
    return <p className="text-[color:var(--color-ink-soft)]">Loading pairing request…</p>;
  }
  if (status.kind === "not_found") {
    return <p className="text-[color:var(--color-wine)]">No such pairing request.</p>;
  }
  if (status.kind === "expired") {
    return (
      <p className="text-[color:var(--color-wine)]">
        This pairing request has expired. Re-run <code>squire-mcp install</code> from your terminal.
      </p>
    );
  }
  if (status.kind === "done") {
    return (
      <div className="space-y-3">
        <p className="text-[color:var(--color-amber-black)]">Pairing complete. You can close this tab.</p>
        <a href="/dashboard" className="text-[color:var(--color-wine)]">Open the dashboard →</a>
      </div>
    );
  }

  const agentLabel = status.agent !== null ? AGENT_DISPLAY[status.agent] ?? status.agent : "your coding agent";

  return (
    <div className="space-y-5">
      <p className="text-[color:var(--color-ink-soft)]">
        Trusty Squire wants to pair with <strong className="text-[color:var(--color-amber-black)]">{agentLabel}</strong>{" "}
        on this machine.
      </p>
      <p className="text-sm text-[color:var(--color-ink-soft)]">
        Approving will give that agent permission to act under your mandate. You can revoke it any
        time from Settings.
      </p>
      {error !== null ? (
        <p role="alert" className="text-[color:var(--color-wine)] text-sm">
          {error}
        </p>
      ) : null}
      <Button onClick={onConfirm} disabled={pending} className="w-full">
        {pending ? "Pairing…" : "Approve pairing"}
      </Button>
    </div>
  );
}
