import { AppShell } from "@/components/shell/AppShell";
import { SettingsClient } from "@/components/shell/SettingsClient";

export default function SettingsPage() {
  return (
    <AppShell active="settings">
      <h1 className="text-3xl mb-6 text-[color:var(--color-wine)]">Settings</h1>
      <SettingsClient />
    </AppShell>
  );
}
