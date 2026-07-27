"use client";

import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CardEntry } from "../../components/CardEntry";

// Add-only. Viewing, renaming, and deleting a saved card now live inline in
// the vault list's Wallet section — this page is just the add flow. The
// sensitive card entry, client-side storage encryption, and honest trust copy
// come from the shared CardEntry component (also used by the pay page's JIT
// add-card mode).
export default function CardPage() {
  const router = useRouter();
  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Add card</h1>
          <p className="app-sub">Save a card so your agents can pay on your behalf.</p>
        </div>
      </div>

      <CardEntry onSaved={() => router.push("/vault")} />
    </AppShell>
  );
}
