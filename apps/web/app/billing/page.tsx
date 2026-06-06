"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { useQueryParam } from "../lib/use-query-param";

interface BillingStatus {
  subscription_status: string;
  has_customer: boolean;
  current_period_end: string | null;
  cancel_at: string | null;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Mirrors the server's subscription-status helper: which statuses unlock
// the paid tier (and so show "Manage" instead of "Upgrade").
function isActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

// After checkout Stripe redirects here immediately, but the webhook that
// flips us to `active` can land a beat later. Poll the real status for a
// short window so we show the truth — never a stale "Free plan" sitting
// under a "you're subscribed" banner.
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 25000;

export default function BillingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Outcome flags from the Stripe redirect — derived from the query param
  // rather than seeded via an effect (which trips set-state-in-effect).
  const statusParam = useQueryParam("status");
  const justPaid = statusParam === "success";
  const cancelled = statusParam === "cancelled";
  // Polling for the webhook to land after a successful payment runs until
  // the status goes active or the window times out. `finalizing` is the
  // not-yet-done view of that, derived so the effect never seeds state.
  const [pollDone, setPollDone] = useState(false);
  const finalizing = !pollDone;

  // Load status once; if we just paid, keep polling until active or timeout.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    async function load(): Promise<void> {
      try {
        const res = await apiGet<BillingStatus>("/v1/billing/status");
        if (stopped) return;
        setStatus(res);

        if (justPaid && !isActive(res.subscription_status)) {
          if (Date.now() - startedAt < POLL_TIMEOUT_MS) {
            timer = setTimeout(load, POLL_INTERVAL_MS);
            return; // keep finalizing
          }
          // Webhook hasn't landed within the window. Stop polling, but do NOT
          // fall back to the Upgrade card — they paid. Show a soft notice.
          setPollDone(true);
          return;
        }
        setPollDone(true);
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/billing");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load billing status.");
        setPollDone(true);
      }
    }

    void load();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [router, justPaid]);

  // Open Stripe Checkout (subscribe) or the Billing Portal (manage) by
  // asking the API for the hosted URL, then navigating to it.
  const go = useCallback(async (path: "/v1/billing/checkout" | "/v1/billing/portal") => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ url: string }>(path);
      window.location.href = res.url;
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 503) {
        setError("Billing isn't available yet — check back soon.");
        return;
      }
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  }, []);

  const active = status !== null && isActive(status.subscription_status);
  // Paid, but the webhook hasn't flipped us to active yet (or didn't in time).
  const awaitingActivation = justPaid && !active;

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Billing</h1>
          <p className="app-sub">Your Trusty Squire plan.</p>
        </div>
      </div>

      {cancelled && !active && (
        <div className="app-banner">Checkout cancelled — no charge was made.</div>
      )}
      {error !== null && <div className="app-banner err">{error}</div>}

      {/* First load on a normal visit (not a post-checkout return). */}
      {status === null && !awaitingActivation && error === null && (
        <p className="app-sub">Loading…</p>
      )}

      {/* Active subscription — the only place the success banner appears. */}
      {active && (
        <div className="app-card">
          {justPaid && (
            <div className="app-banner ok" style={{ marginTop: 0, marginBottom: 16 }}>
              You&apos;re subscribed — thanks! Your signups are now unlimited.
            </div>
          )}
          <h2 className="app-title" style={{ fontSize: "18px" }}>
            {status?.cancel_at != null ? "Paid plan — cancels soon" : "Paid plan — active"}
          </h2>
          {status?.cancel_at != null ? (
            <p className="app-sub">
              Unlimited signups until {fmtDate(status.cancel_at)}. Your plan is set to cancel
              then — reopen Manage to resume it before the date.
            </p>
          ) : (
            <p className="app-sub">
              Unlimited signups.
              {status?.current_period_end != null
                ? ` Renews ${fmtDate(status.current_period_end)}.`
                : ""}
            </p>
          )}
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => go("/v1/billing/portal")}
          >
            {busy ? "Opening…" : "Manage subscription"}
          </button>
        </div>
      )}

      {/* Just paid, waiting on the webhook to confirm. No Upgrade button. */}
      {awaitingActivation && finalizing && (
        <div className="app-card">
          <h2 className="app-title" style={{ fontSize: "18px" }}>
            Finalizing your subscription…
          </h2>
          <p className="app-sub">
            Payment received. Confirming with Stripe — this usually takes a few seconds.
          </p>
        </div>
      )}

      {/* Paid, but activation didn't land in the poll window. Still no Upgrade. */}
      {awaitingActivation && !finalizing && (
        <div className="app-card">
          <h2 className="app-title" style={{ fontSize: "18px" }}>
            Payment received
          </h2>
          <p className="app-sub">
            Your subscription is taking a moment to activate. Refresh shortly — if it still
            doesn&apos;t update, reach out and we&apos;ll sort it.
          </p>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => window.location.assign("/billing")}
          >
            Refresh
          </button>
        </div>
      )}

      {/* Genuinely on the free plan. */}
      {status !== null && !active && !awaitingActivation && (
        <div className="app-card">
          <h2 className="app-title" style={{ fontSize: "18px" }}>
            Free plan
          </h2>
          <p className="app-sub">
            You&apos;ve used your free signups. Upgrade for unlimited provisioning.
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={() => go("/v1/billing/checkout")}
          >
            {busy ? "Opening…" : "Upgrade"}
          </button>
        </div>
      )}
    </AppShell>
  );
}
