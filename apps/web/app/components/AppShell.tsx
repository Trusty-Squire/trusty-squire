"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { apiPost } from "../lib/api";
import { Shield } from "./Shield";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
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
          <Link className={pathname === "/billing" ? "on" : ""} href="/billing">
            Billing
          </Link>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
