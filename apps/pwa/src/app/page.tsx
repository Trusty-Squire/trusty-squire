import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export default function HomePage() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center">
        <Logo className="mx-auto mb-8 h-20 w-20" />
        <h1 className="text-5xl mb-4 text-[color:var(--color-wine)]">Trusty Squire</h1>
        <p className="text-lg text-[color:var(--color-ink-soft)] mb-10">
          Your squire handles the rest. Sign up for the SaaS your coding agent needs — without
          handing it your credit card.
        </p>
        <div className="flex justify-center gap-4">
          <Link
            href="/signup"
            className="px-6 py-3 rounded-lg bg-[color:var(--color-wine)] text-[color:var(--color-cream-soft)] no-underline hover:bg-[color:var(--color-wine-deep)]"
          >
            Get started
          </Link>
          <Link
            href="/login"
            className="px-6 py-3 rounded-lg border border-[color:var(--color-rule)] no-underline text-[color:var(--color-amber-black)]"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
