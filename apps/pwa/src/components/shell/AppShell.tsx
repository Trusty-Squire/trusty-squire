import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

interface AppShellProps {
  children: ReactNode;
  active?: "dashboard" | "ledger" | "subscriptions" | "policy" | "settings";
}

const NAV = [
  { href: "/dashboard", label: "Dashboard", key: "dashboard" as const },
  { href: "/ledger", label: "Ledger", key: "ledger" as const },
  { href: "/subscriptions", label: "Subscriptions", key: "subscriptions" as const },
  { href: "/policy", label: "Policy", key: "policy" as const },
  { href: "/settings", label: "Settings", key: "settings" as const },
];

export function AppShell({ children, active }: AppShellProps) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
        <div className="mx-auto max-w-6xl px-6 py-4 flex items-center gap-8">
          <Link href="/dashboard" className="flex items-center gap-2 no-underline">
            <Logo className="h-8 w-8" />
            <span className="font-medium text-[color:var(--color-text)]">Trusty Squire</span>
          </Link>
          <nav className="flex gap-1 ml-auto">
            {NAV.map((item) => {
              const isActive = item.key === active;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-md no-underline text-sm ${
                    isActive
                      ? "bg-[color:var(--color-surface)] text-[color:var(--color-text)]"
                      : "text-[color:var(--color-text-soft)] hover:text-[color:var(--color-text)]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1 mx-auto w-full max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
