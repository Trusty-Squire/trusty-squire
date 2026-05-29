"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ApprovalCard, type AccessRequest } from "../../components/ApprovalCard";
import { ApiError, apiGet } from "../../lib/api";

export default function ApprovalsPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<{ requests: AccessRequest[] }>(
        "/v1/vault/access-requests?status=pending",
      );
      setRequests(res.requests);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login?next=/vault/approvals");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load approvals.");
    }
  }, [router]);

  useEffect(() => {
    void load();
    // Live deltas via SSE; the stream emits a "pending" event whenever
    // the count changes — we re-fetch the full list on each tick. Falls
    // back gracefully: if the stream errors, the initial load still ran.
    const es = new EventSource("/v1/vault/approvals/stream", {
      withCredentials: true,
    });
    es.addEventListener("pending", () => {
      void load();
    });
    es.onerror = () => {
      /* keep the last-loaded list; EventSource auto-reconnects */
    };
    return () => es.close();
  }, [load]);

  const onResolved = useCallback((id: string) => {
    setRequests((prev) => prev?.filter((r) => r.request_id !== id) ?? prev);
  }, []);

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Approvals</h1>
          <p className="app-sub">
            Agents waiting on your decision to use a credential.
          </p>
        </div>
        {requests !== null && (
          <span className="app-count">{requests.length}</span>
        )}
      </div>

      {error !== null && (
        <div className="app-state">
          <div className="big">Couldn&apos;t load approvals</div>
          <p className="hint">{error}</p>
        </div>
      )}

      {error === null && requests === null && (
        <div className="app-state">
          <p className="hint">Loading…</p>
        </div>
      )}

      {requests !== null && requests.length === 0 && (
        <div className="app-state">
          <div className="big">Nothing waiting</div>
          <p className="hint">
            When an agent asks to use a credential, it shows up here for your
            approval.
          </p>
        </div>
      )}

      {requests !== null &&
        requests.map((req) => (
          <ApprovalCard key={req.request_id} req={req} onResolved={onResolved} />
        ))}
    </AppShell>
  );
}
