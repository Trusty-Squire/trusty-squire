import { AppShell } from "@/components/shell/AppShell";
import { DashboardClient } from "@/components/shell/DashboardClient";

export default function DashboardPage() {
  return (
    <AppShell active="dashboard">
      <h1 className="text-3xl mb-6">Dashboard</h1>
      <DashboardClient />
    </AppShell>
  );
}
