import { AuthLayout } from "@/components/auth/AuthLayout";
import { PairConfirm } from "@/components/auth/PairConfirm";

interface PairPageProps {
  searchParams: Promise<{ token?: string }>;
}

// We can't read the session cookie from a Server Component without
// wiring an API call; for v0 we rely on the client-side fetch in
// PairConfirm to hit the API (which will 401 if not logged in — the
// component shows a friendly fallback to /login then).
export default async function PairPage({ searchParams }: PairPageProps) {
  const { token } = await searchParams;
  if (token === undefined || token.length === 0) {
    return (
      <AuthLayout title="Pair your coding agent">
        <p className="text-[color:var(--color-wine)]">
          Missing pairing token. Re-run <code>squire-mcp install</code>.
        </p>
      </AuthLayout>
    );
  }
  // Email is needed for Vouchflow userHandle; we read it from localStorage
  // in the client island after login. PairConfirm falls back to empty.
  return (
    <AuthLayout title="Pair your coding agent">
      <PairConfirm token={token} email="" />
    </AuthLayout>
  );
}
