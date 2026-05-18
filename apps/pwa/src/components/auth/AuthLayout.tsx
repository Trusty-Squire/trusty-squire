import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

interface AuthLayoutProps {
  title: string;
  step?: number;
  totalSteps?: number;
  children: ReactNode;
}

export function AuthLayout({ title, step, totalSteps, children }: AuthLayoutProps) {
  return (
    <main className="min-h-screen flex items-start justify-center px-6 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="flex items-center gap-2 no-underline mb-8">
          <Logo className="h-8 w-8" />
          <span className="font-medium text-[color:var(--color-text)]">Trusty Squire</span>
        </Link>
        {step !== undefined && totalSteps !== undefined ? (
          <p className="text-xs text-[color:var(--color-text-soft)] mb-2">
            Step {step} of {totalSteps}
          </p>
        ) : null}
        <h1 className="text-3xl mb-6">{title}</h1>
        {children}
      </div>
    </main>
  );
}
