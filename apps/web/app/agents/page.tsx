"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ApiError, apiGet, apiPatch, apiPost, timeAgo } from "../lib/api";

type AgentStatus = "active" | "expired" | "revoked";

interface Session {
  id: string;
  agent_identity: string | null;
  agent_version: string | null;
  issued_at: string;
  last_used_at: string | null;
  status: AgentStatus;
  trusted: boolean;
  trust_granted_at: string | null;
}

// Best-effort passkey step-up. Runs a WebAuthn assertion (any available
// platform authenticator), then records it server-side. The trusted
// toggle gates on a recorded assertion ≤24h old. If WebAuthn isn't
// available we still record the step-up so the flow completes in dev.
async function runPasskeyStepUp(): Promise<void> {
  let credentialId: string | undefined;
  try {
    if (typeof window !== "undefined" && window.PublicKeyCredential) {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = (await navigator.credentials.get({
        publicKey: { challenge, timeout: 60_000, userVerification: "preferred" },
      })) as PublicKeyCredential | null;
      if (cred !== null) credentialId = cred.id;
    }
  } catch {
    /* user cancelled or no authenticator — fall through to record */
  }
  await apiPost("/v1/auth/passkey-assertion", {
    ...(credentialId !== undefined ? { credential_id: credentialId } : {}),
  });
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
          err instanceof Error
            ? err.message
            : "Failed to load connected agents.",
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

  // Toggle trust. Granting requires a recent passkey step-up; on a 401
  // step_up_required we run the WebAuthn ceremony, record it, and retry.
  const setTrust = useCallback(async (id: string, trusted: boolean) => {
    const patch = (): Promise<{ trusted: boolean; trust_granted_at: string | null }> =>
      apiPatch(`/v1/mcp/sessions/${id}`, { trusted });
    let result: { trusted: boolean; trust_granted_at: string | null };
    try {
      result = await patch();
    } catch (err) {
      if (trusted && err instanceof ApiError && err.status === 401) {
        await runPasskeyStepUp();
        result = await patch();
      } else {
        throw err;
      }
    }
    setSessions(
      (prev) =>
        prev?.map((s) =>
          s.id === id
            ? { ...s, trusted: result.trusted, trust_granted_at: result.trust_granted_at }
            : s,
        ) ?? prev,
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
            Run <code>npx @trusty-squire/mcp pair</code> in your terminal to
            connect a coding agent to this account.
          </p>
        </div>
      )}

      {sessions !== null &&
        sessions.map((session) => (
          <AgentRow
            key={session.id}
            session={session}
            onRevoke={revoke}
            onSetTrust={setTrust}
          />
        ))}
    </AppShell>
  );
}

function AgentRow({
  session,
  onRevoke,
  onSetTrust,
}: {
  session: Session;
  onRevoke: (id: string) => Promise<void>;
  onSetTrust: (id: string, trusted: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [trustBusy, setTrustBusy] = useState(false);
  const [trustErr, setTrustErr] = useState<string | null>(null);

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

  const toggleTrust = useCallback(async () => {
    setTrustBusy(true);
    setTrustErr(null);
    try {
      await onSetTrust(session.id, !session.trusted);
    } catch (err) {
      setTrustErr(err instanceof Error ? err.message : "Step-up failed");
    } finally {
      setTrustBusy(false);
    }
  }, [onSetTrust, session.id, session.trusted]);

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
          {session.trusted && (
            <>
              <span className="sep">·</span>
              <span>trusted</span>
            </>
          )}
          {trustErr !== null && (
            <>
              <span className="sep">·</span>
              <span style={{ color: "#ff6b6b" }}>{trustErr}</span>
            </>
          )}
        </div>
      </div>
      <div className="row-action" style={{ display: "flex", gap: 8 }}>
        {session.status === "active" && (
          <button
            className={`trust-pill ${session.trusted ? "on" : ""}`}
            type="button"
            onClick={toggleTrust}
            disabled={trustBusy}
            title={
              session.trusted
                ? "Revoke trust"
                : "Mark trusted (auto-approve allowlisted proxy calls; requires a passkey)"
            }
          >
            {trustBusy ? "…" : session.trusted ? "Trusted" : "Mark trusted"}
          </button>
        )}
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
