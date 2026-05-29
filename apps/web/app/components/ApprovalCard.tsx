"use client";

import { useCallback, useState } from "react";
import { apiPost, timeAgo } from "../lib/api";

export interface AccessRequest {
  request_id: string;
  reference: string;
  service: string | null;
  agent_identity: string | null;
  intent: "value" | "proxy";
  mode: "once" | "session" | "persistent";
  purpose: string;
  reason_proxy_not_possible: string | null;
  requested_target_host: string | null;
  requested_at: string;
  expires_at: string | null;
  status: string;
}

// TTL presets. 7d is the locked default; 30d sits behind an explicit
// pick (the "I won't see another approval for 30 days" choice).
const TTL_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "1 day", seconds: 24 * 60 * 60 },
  { label: "7 days", seconds: 7 * 24 * 60 * 60 },
  { label: "30 days", seconds: 30 * 24 * 60 * 60 },
];
const DEFAULT_TTL = 7 * 24 * 60 * 60;

export function ApprovalCard({
  req,
  onResolved,
}: {
  req: AccessRequest;
  onResolved: (id: string) => void;
}) {
  const [ttl, setTtl] = useState<number>(DEFAULT_TTL);
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = useCallback(
    async (decision: "approve" | "deny") => {
      setBusy(decision);
      setError(null);
      try {
        await apiPost(`/v1/vault/access-requests/${req.request_id}/decision`, {
          decision,
          ...(decision === "approve" ? { ttl_seconds: ttl } : {}),
        });
        onResolved(req.request_id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed.");
        setBusy(null);
      }
    },
    [req.request_id, ttl, onResolved],
  );

  return (
    <div className="approval">
      <div className="approval-top">
        <div className="approval-title">
          {req.service ?? "A credential"}
        </div>
        <span className={`approval-intent ${req.intent}`}>{req.intent}</span>
      </div>

      <div className="approval-meta">
        <div>
          <span className="k">agent</span> {req.agent_identity ?? "unknown agent"}
        </div>
        <div>
          <span className="k">purpose</span> {req.purpose}
        </div>
        {req.intent === "proxy" && req.requested_target_host !== null && (
          <div>
            <span className="k">calls</span> <code>{req.requested_target_host}</code>
          </div>
        )}
        {req.intent === "value" && req.reason_proxy_not_possible !== null && (
          <div>
            <span className="k">raw value because</span>{" "}
            {req.reason_proxy_not_possible}
          </div>
        )}
        <div>
          <span className="k">requested</span> {timeAgo(req.requested_at)}
        </div>
      </div>

      {req.intent === "value" && (
        <div className="approval-ttl">
          {TTL_OPTIONS.map((o) => (
            <button
              key={o.seconds}
              type="button"
              className={`ttl-opt ${ttl === o.seconds ? "on" : ""}`}
              onClick={() => setTtl(o.seconds)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}

      {error !== null && <div className="form-err" style={{ marginTop: 10 }}>{error}</div>}

      <div className="approval-actions">
        <button
          className="btn-approve"
          type="button"
          onClick={() => decide("approve")}
          disabled={busy !== null}
        >
          {busy === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          className="btn-deny"
          type="button"
          onClick={() => decide("deny")}
          disabled={busy !== null}
        >
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
