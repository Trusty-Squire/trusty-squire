"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api-client";

export function SettingsClient() {
  const [pending, setPending] = useState(false);

  async function onLogout() {
    setPending(true);
    try {
      await api.logout();
    } finally {
      setPending(false);
      window.location.href = "/";
    }
  }

  return (
    <div className="space-y-4">
      <Button variant="secondary" onClick={onLogout} disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </Button>
    </div>
  );
}
