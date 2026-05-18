import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <Logo className="mx-auto mb-8 h-16 w-16" />
        <h1 className="text-5xl mb-4">Trusty Squire</h1>
        <p className="text-lg text-[color:var(--color-text-soft)] mb-10">
          Your squire handles the rest. It signs your coding agent up for the
          SaaS it needs — and never hands over your card.
        </p>
        <div className="flex justify-center gap-3">
          <Link
            href="/signup"
            className="px-6 py-3 rounded-md bg-[color:var(--color-accent-fill)] text-[color:var(--color-accent-contrast)] no-underline transition-colors hover:bg-[color:var(--color-accent-fill-hover)]"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="px-6 py-3 rounded-md border border-[color:var(--color-border)] no-underline text-[color:var(--color-text)] transition-colors hover:bg-[color:var(--color-surface)] hover:border-[color:var(--color-border-strong)]"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
