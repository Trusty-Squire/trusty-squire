"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ApiError, apiGet, apiPost } from "../lib/api";

interface BillingStatus {
  subscription_status: string;
  has_customer: boolean;
  current_period_end: string | null;
}

// Mirrors the server's subscription-status helper: which statuses unlock
// the paid tier (and so show "Manage" instead of "Upgrade").
function isActive(status: string): boolean {
  return status === "active" || status === "trialing";
}

export default function BillingPage() {
  const router = useRouter();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<"success" | "cancelled" | null>(null);

  // Read the post-checkout redirect outcome (?status=success|cancelled)
  // on the client to avoid a useSearchParams Suspense boundary.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("status");
    if (q === "success" || q === "cancelled") setBanner(q);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<BillingStatus>("/v1/billing/status");
        if (!cancelled) setStatus(res);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/billing");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load billing status.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

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

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Billing</h1>
          <p className="app-sub">Your Trusty Squire plan.</p>
        </div>
      </div>

      {banner === "success" && (
        <div className="app-banner ok">You&apos;re subscribed — thanks! Your signups are now unlimited.</div>
      )}
      {banner === "cancelled" && (
        <div className="app-banner">Checkout cancelled — no charge was made.</div>
      )}
      {error !== null && <div className="app-banner err">{error}</div>}

      {status === null && error === null && <p className="app-sub">Loading…</p>}

      {status !== null && (
        <div className="app-card">
          {active ? (
            <>
              <h2 className="app-title" style={{ fontSize: "18px" }}>Paid plan — active</h2>
              <p className="app-sub">
                Unlimited signups.
                {status.current_period_end !== null
                  ? ` Renews ${new Date(status.current_period_end).toLocaleDateString()}.`
                  : ""}
              </p>
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => go("/v1/billing/portal")}
              >
                {busy ? "Opening…" : "Manage subscription"}
              </button>
            </>
          ) : (
            <>
              <h2 className="app-title" style={{ fontSize: "18px" }}>Free plan</h2>
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
            </>
          )}
        </div>
      )}
    </AppShell>
  );
}
