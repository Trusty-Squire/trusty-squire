import { AppShell } from "@/components/shell/AppShell";
import { HeraldicShield } from "@/components/shell/HeraldicShield";
import { DashboardClient } from "@/components/shell/DashboardClient";

export default function DashboardPage() {
  return (
    <AppShell active="dashboard">
      <h1 className="text-3xl mb-6 text-[color:var(--color-wine)]">Dashboard</h1>
      <DashboardClient />
      <HeraldicShield />
    </AppShell>
  );
}
