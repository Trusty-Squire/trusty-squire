"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { ApiError, apiGet, timeAgo } from "../../lib/api";

// One row of the who-touched-my-keys trail. The server flattens the audit
// payload onto the event, so every field here is non-secret by design.
interface AuditEvent {
  id: string;
  type: string;
  emitted_at: string;
  reference?: string;
  requester?: string;
  purpose?: string;
  outcome?: string;
  service?: string;
  label?: string;
  target_host?: string;
  response_status?: number;
}

const PAGE = 50;

// Maps an event to { tone, label, detail } for the timeline. Tone drives
// the status dot color (ok / warn / err / neutral).
function describe(e: AuditEvent): { tone: string; label: string; detail: string } {
  const svc = e.service ?? refTail(e.reference);
  switch (e.type) {
    case "vault.credential_stored":
      return { tone: "ok", label: "Stored", detail: svc };
    case "vault.credential_rotated":
      return { tone: "neutral", label: "Rotated", detail: svc };
    case "vault.credential_restored":
      return { tone: "ok", label: "Restored", detail: svc };
    case "vault.credential_collapsed":
      return { tone: "neutral", label: "Merged", detail: `${svc} (dedup)` };
    case "vault.credential_deleted":
      return e.purpose === "user:revoke_all"
        ? { tone: "err", label: "Revoked", detail: `${svc} (kill-switch)` }
        : { tone: "warn", label: "Deleted", detail: svc };
    case "vault.credential_retrieved": {
      const verb = e.purpose === "user:vault_reveal" ? "Revealed" : "Retrieved";
      if (e.outcome === "rate_limited") return { tone: "err", label: "Rate-limited", detail: svc };
      if (e.outcome === "missing_credential") return { tone: "warn", label: "Retrieve (missing)", detail: svc };
      if (e.outcome === "stale_assertion") return { tone: "warn", label: "Retrieve (stale)", detail: svc };
      return { tone: "neutral", label: verb, detail: svc };
    }
    case "vault.proxy_executed":
      return { tone: "ok", label: "Used", detail: e.target_host ?? svc };
    case "vault.proxy_rejected":
      return { tone: "err", label: "Blocked", detail: `${e.target_host ?? "off-allowlist host"} (not allowed)` };
    default:
      return { tone: "neutral", label: e.type.replace("vault.", ""), detail: svc };
  }
}

// vault://account/sub/ULID → the trailing ULID, the only human-stable
// handle when no service is on the payload.
function refTail(ref?: string): string {
  if (ref === undefined) return "—";
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}

export default function ActivityPage() {
  const router = useRouter();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (before?: string): Promise<void> => {
    const qs = new URLSearchParams({ limit: String(PAGE) });
    if (before !== undefined) qs.set("before", before);
    const res = await apiGet<{ events: AuditEvent[]; next_before: string | null }>(
      `/v1/vault/audit?${qs.toString()}`,
    );
    setEvents((prev) => (before === undefined ? res.events : [...(prev ?? []), ...res.events]));
    setCursor(res.next_before);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetchPage();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/activity");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load activity.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, fetchPage]);

  const more = useCallback(async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      await fetchPage(cursor);
    } catch {
      /* keep what we have */
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, fetchPage]);

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Activity</h1>
          <p className="app-sub">Every touch of your keys — stored, used, rotated, revoked.</p>
        </div>
        <div className="app-head-actions">
          <Link className="head-btn" href="/vault">
            ← Vault
          </Link>
        </div>
      </div>

      {error !== null && (
        <div className="app-state">
          <div className="big">Couldn&apos;t load activity</div>
          <p className="hint">{error}</p>
        </div>
      )}

      {error === null && events === null && (
        <div className="app-state">
          <p className="hint">Loading…</p>
        </div>
      )}

      {events !== null && events.length === 0 && (
        <div className="app-state">
          <div className="big">Nothing yet</div>
          <p className="hint">Activity shows up here as your squire stores and uses keys.</p>
        </div>
      )}

      {events !== null && events.length > 0 && (
        <>
          <div className="timeline">
            {events.map((e) => {
              const d = describe(e);
              return (
                <div className="tl-row" key={e.id}>
                  <span className={`tl-dot ${d.tone}`} aria-hidden="true" />
                  <div className="tl-main">
                    <div className="tl-line">
                      <span className="tl-label">{d.label}</span>
                      <span className="tl-detail">{d.detail}</span>
                    </div>
                    <div className="tl-meta">
                      {e.requester !== undefined && <span>{e.requester}</span>}
                      {e.response_status !== undefined && (
                        <>
                          <span className="dot">·</span>
                          <span>{e.response_status}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <time className="tl-time" dateTime={e.emitted_at} title={new Date(e.emitted_at).toLocaleString()}>
                    {timeAgo(e.emitted_at)}
                  </time>
                </div>
              );
            })}
          </div>
          {cursor !== null && (
            <button className="head-btn load-more" type="button" onClick={more} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </AppShell>
  );
}
