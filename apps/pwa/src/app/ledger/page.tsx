import { AppShell } from "@/components/shell/AppShell";
import { LedgerClient } from "@/components/shell/LedgerClient";

export default function LedgerPage() {
  return (
    <AppShell active="ledger">
      <h1 className="text-3xl mb-6">Audit ledger</h1>
      <p className="text-[color:var(--color-text-soft)] mb-6">
        Every action your squire takes lands here. Append-only.
      </p>
      <LedgerClient />
    </AppShell>
  );
}
