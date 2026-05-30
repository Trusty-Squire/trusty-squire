"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ApiError, apiGet, apiPost, timeAgo } from "../lib/api";

type AgentStatus = "active" | "expired" | "revoked";

interface Session {
  id: string;
  agent_identity: string | null;
  agent_version: string | null;
  issued_at: string;
  last_used_at: string | null;
  status: AgentStatus;
}

export default function AgentsPage() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ sessions: Session[] }>("/v1/mcp/sessions");
        if (!cancelled) setSessions(res.sessions);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/agents");
          return;
        }
        setError(
          err instanceof Error ? err.message : "Failed to load connected agents.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const revoke = useCallback(async (id: string) => {
    await apiPost(`/v1/mcp/sessions/${id}/revoke`);
    setSessions(
      (prev) =>
        prev?.map((s) => (s.id === id ? { ...s, status: "revoked" } : s)) ??
        prev,
    );
  }, []);

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Connected agents</h1>
          <p className="app-sub">CLIs paired to your account.</p>
        </div>
        {sessions !== null && (
          <span className="app-count">{sessions.length}</span>
        )}
      </div>

      {error !== null && (
        <div className="app-state">
          <div className="big">Couldn&apos;t load your agents</div>
          <p className="hint">{error}</p>
        </div>
      )}

      {error === null && sessions === null && (
        <div className="app-state">
          <p className="hint">Loading…</p>
        </div>
      )}

      {sessions !== null && sessions.length === 0 && (
        <div className="app-state">
          <div className="big">No agents paired</div>
          <p className="hint">
            Run <code>npx @trusty-squire/mcp connect</code> in your terminal to
            connect a coding agent to this account.
          </p>
        </div>
      )}

      {sessions !== null &&
        sessions.map((session) => (
          <AgentRow key={session.id} session={session} onRevoke={revoke} />
        ))}
    </AppShell>
  );
}

function AgentRow({
  session,
  onRevoke,
}: {
  session: Session;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      await onRevoke(session.id);
    } catch {
      /* leave the row as-is on failure */
    } finally {
      setBusy(false);
    }
  }, [onRevoke, session.id]);

  return (
    <div className="row">
      <div className="row-glyph">
        <TerminalGlyph />
      </div>
      <div className="row-main">
        <div className="row-title">
          {session.agent_identity ?? "Coding agent"}
        </div>
        <div className="row-meta">
          <span className={`sdot ${session.status}`} />
          <span>{session.status}</span>
          {session.agent_version !== null && (
            <>
              <span className="sep">·</span>
              <span>v{session.agent_version}</span>
            </>
          )}
          {session.last_used_at !== null && (
            <>
              <span className="sep">·</span>
              <span>last used {timeAgo(session.last_used_at)}</span>
            </>
          )}
        </div>
      </div>
      <div className="row-action">
        {session.status === "active" && (
          <button
            className="pill-btn danger"
            type="button"
            onClick={revoke}
            disabled={busy}
          >
            {busy ? "…" : "Revoke"}
          </button>
        )}
      </div>
    </div>
  );
}

function TerminalGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 7l4 4-4 4" />
      <path d="M12 16h7" />
    </svg>
  );
}
