"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { apiGet, apiPost } from "../lib/api";
import { Shield } from "./Shield";

interface PlanStatus {
  subscription_status: string;
  cancel_at: string | null;
}

function isPro(status: PlanStatus | null): boolean {
  return (
    status !== null &&
    (status.subscription_status === "active" || status.subscription_status === "trialing")
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [plan, setPlan] = useState<PlanStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // Plan pill — at-a-glance tier. Best-effort: if it fails, no pill renders.
  useEffect(() => {
    let stopped = false;
    apiGet<PlanStatus>("/v1/billing/status")
      .then((s) => {
        if (!stopped) setPlan(s);
      })
      .catch(() => {
        /* no pill on error */
      });
    return () => {
      stopped = true;
    };
  }, []);

  async function signOut() {
    setMenuOpen(false);
    try {
      await apiPost("/v1/auth/logout");
    } catch {
      /* already signed out — fall through to the redirect */
    }
    router.push("/");
  }

  return (
    <div className="app-shell">
      <header className="app-nav">
        <Link className="brand" href="/vault">
          <Shield glyph />
          Trusty Squire
        </Link>
        <div className="nav-r">
          <Link className={pathname === "/vault" ? "on" : ""} href="/vault">
            Vault
          </Link>
          <Link className={pathname === "/vault/activity" ? "on" : ""} href="/vault/activity">
            Activity
          </Link>
          <Link className={pathname === "/agents" ? "on" : ""} href="/agents">
            Agents
          </Link>

          {/* Split by intent: free → an Upgrade action; paid → a quiet status
              chip (a label, not a control). Management lives in Account ▾. */}
          {plan !== null &&
            (isPro(plan) ? (
              <span className="plan-chip">Pro</span>
            ) : (
              <Link className="plan-cta" href="/billing" title="Upgrade to unlimited">
                Upgrade
              </Link>
            ))}

          <div className="acct-menu">
            <button
              type="button"
              className="acct-trigger"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
            >
              Account
              <span className="acct-caret" aria-hidden>
                ▾
              </span>
            </button>
            {menuOpen && (
              <>
                <div className="acct-backdrop" onClick={() => setMenuOpen(false)} aria-hidden />
                <div className="acct-dropdown" role="menu">
                  <Link role="menuitem" href="/billing" onClick={() => setMenuOpen(false)}>
                    Billing
                  </Link>
                  <button type="button" role="menuitem" onClick={signOut}>
                    Sign out
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
