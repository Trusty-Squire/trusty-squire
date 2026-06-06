"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiPost } from "../lib/api";

// Pre-authenticated upgrade landing. The paywall (402) hands the agent a link
// to /upgrade?t=<token>; this page exchanges that token for a Stripe Checkout
// URL and redirects straight there — no login. The token is the auth, so this
// page is deliberately session-less and does nothing else.
export default function UpgradePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("t");
    if (token === null || token.length === 0) {
      router.replace("/billing");
      return;
    }
    let stopped = false;
    (async () => {
      try {
        const res = await apiPost<{ url: string }>("/v1/billing/checkout-from-token", { token });
        if (!stopped) window.location.href = res.url;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && err.status === 409) {
          // Already subscribed — nothing to buy.
          router.replace("/billing");
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          setError("This upgrade link has expired. Open Billing to upgrade.");
          return;
        }
        setError("Couldn't start checkout. Open Billing to try again.");
      }
    })();
    return () => {
      stopped = true;
    };
  }, [router]);

  return (
    <main className="upgrade-shell">
      {error === null ? (
        <p className="app-sub">Starting checkout…</p>
      ) : (
        <div className="app-card" style={{ textAlign: "center" }}>
          <p className="app-sub" style={{ marginTop: 0 }}>{error}</p>
          <button
            type="button"
            className="btn-primary"
            onClick={() => router.replace("/billing")}
          >
            Open Billing
          </button>
        </div>
      )}
    </main>
  );
}
