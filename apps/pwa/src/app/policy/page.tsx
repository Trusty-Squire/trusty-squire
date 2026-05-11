import { AppShell } from "@/components/shell/AppShell";
import { PolicyClient } from "@/components/shell/PolicyClient";

export default function PolicyPage() {
  return (
    <AppShell active="policy">
      <h1 className="text-3xl mb-6 text-[color:var(--color-wine)]">Policy</h1>
      <p className="text-[color:var(--color-ink-soft)] mb-6 max-w-2xl">
        These are the limits your squire operates under. Changes are signed with your passkey and
        replace the previous mandate.
      </p>
      <PolicyClient />
    </AppShell>
  );
}
