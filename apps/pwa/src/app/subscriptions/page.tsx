import { AppShell } from "@/components/shell/AppShell";
import { SubscriptionsClient } from "@/components/shell/SubscriptionsClient";

export default function SubscriptionsPage() {
  return (
    <AppShell active="subscriptions">
      <h1 className="text-3xl mb-6">Subscriptions</h1>
      <SubscriptionsClient />
    </AppShell>
  );
}
