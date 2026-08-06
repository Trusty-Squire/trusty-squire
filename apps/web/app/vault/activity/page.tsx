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
  // Card + payment events — display metadata only, never a PAN/CVV.
  brand?: string;
  last4?: string;
  merchant?: string;
  amount_cents?: number;
  currency?: string;
  payment_status?: string;
  // Egress-grant lifecycle.
  grant_id?: string;
}

const PAGE = 50;

function formatAmount(amountCents: number, currency: string): string {
  try {
    const minorDigits = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits;
    if (minorDigits === undefined) return `${currency} ${amountCents} minor units`;
    return `${currency} ${(amountCents / 10 ** minorDigits).toFixed(minorDigits)}`;
  } catch {
    return `${currency} ${amountCents} minor units`;
  }
}

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
      if (e.outcome === "missing_credential")
        return { tone: "warn", label: "Retrieve (missing)", detail: svc };
      if (e.outcome === "stale_assertion")
        return { tone: "warn", label: "Retrieve (stale)", detail: svc };
      return { tone: "neutral", label: verb, detail: svc };
    }
    case "vault.proxy_executed":
      return { tone: "ok", label: "Used", detail: e.target_host ?? svc };
    case "vault.proxy_rejected":
      return {
        tone: "err",
        label: "Blocked",
        detail: `${e.target_host ?? "off-allowlist host"} (not allowed)`,
      };
    case "vault.card_stored":
      return { tone: "ok", label: "Card added", detail: cardDetail(e) };
    case "vault.card_deleted":
      return { tone: "warn", label: "Card removed", detail: cardDetail(e) };
    case "vault.payment_executed": {
      // Merchant + amount + last4 only — a full PAN never reaches the trail.
      const amount =
        e.amount_cents !== undefined && e.currency !== undefined
          ? formatAmount(e.amount_cents, e.currency)
          : null;
      const tail = e.last4 !== undefined ? ` ··${e.last4}` : "";
      const declined =
        e.payment_status !== undefined && /declin|fail|reject/i.test(e.payment_status);
      return {
        tone: declined ? "err" : "ok",
        label: declined ? `Payment ${e.payment_status}` : "Payment",
        detail: `${e.merchant ?? "unknown merchant"}${amount !== null ? ` — ${amount}` : ""}${tail}`,
      };
    }
    case "vault.grant_minted":
      return { tone: "ok", label: "Grant minted", detail: svc };
    case "vault.grant_revoked":
      return { tone: "warn", label: "Grant revoked", detail: svc };
    default:
      return { tone: "neutral", label: e.type.replace("vault.", ""), detail: svc };
  }
}

// "label ··last4" for a card event — the same display shape as the
// wallet row. Falls back through label / last4 / the reference tail.
function cardDetail(e: AuditEvent): string {
  const name = e.label ?? "card";
  return e.last4 !== undefined ? `${name} ··${e.last4}` : name;
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
    void (async () => {
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
                  <time
                    className="tl-time"
                    dateTime={e.emitted_at}
                    title={new Date(e.emitted_at).toLocaleString()}
                  >
                    {timeAgo(e.emitted_at)}
                  </time>
                </div>
              );
            })}
          </div>
          {cursor !== null && (
            <button
              className="head-btn load-more"
              type="button"
              onClick={more}
              disabled={loadingMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
        </>
      )}
    </AppShell>
  );
}
