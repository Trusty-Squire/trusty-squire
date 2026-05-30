"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { apiPost } from "../lib/api";

function Shield() {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      <path
        d="M18 16 H82 V48 Q82 72 50 88 Q18 72 18 48 Z"
        stroke="#f5f5f7"
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <text
        x="50"
        y="60"
        fontFamily="monospace"
        fontSize="30"
        fontWeight="700"
        fill="#8b89ff"
        textAnchor="middle"
      >
        {"{ }"}
      </text>
    </svg>
  );
}

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
          <Shield />
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
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
