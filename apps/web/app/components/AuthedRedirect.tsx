"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// On the marketing landing: if the visitor already has a session, send
// them straight to their vault — the vault is the default view once
// you're signed in. Probes a web-auth-only endpoint (200 = signed in).
// Renders nothing.
export function AuthedRedirect() {
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    fetch("/v1/mcp/sessions", { credentials: "include" })
      .then((res) => {
        if (!cancelled && res.ok) router.replace("/vault");
      })
      .catch(() => {
        /* not signed in, or API unreachable — stay on the landing */
      });
    return () => {
      cancelled = true;
    };
  }, [router]);
  return null;
}
