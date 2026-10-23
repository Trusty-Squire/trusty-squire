"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiGet, apiPost } from "../lib/api";
import { WRONG_ACCOUNT_DEVICE_MESSAGE } from "../lib/pairing";

export function WrongAccountNotice({ approvalPath }: { approvalPath: string }) {
  const router = useRouter();
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiGet<{
      signed_in: boolean;
      email?: string | null;
      display_name?: string | null;
      account_id?: string;
    }>("/v1/auth/whoami").then(
      (session) => {
        if (!cancelled && session.signed_in) {
          setAccount(session.email || session.display_name || session.account_id || null);
        }
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  async function switchAccount() {
    setBusy(true);
    setError(null);
    try {
      try {
        await apiPost("/v1/auth/logout");
      } catch (caught) {
        if (!(caught instanceof ApiError && caught.status === 401)) throw caught;
      }
      router.replace(`/login?next=${encodeURIComponent(approvalPath)}`);
    } catch {
      setError("Could not sign out. Try Switch account again.");
      setBusy(false);
    }
  }

  return (
    <div className="app-banner err" role="alert" style={{ overflowWrap: "anywhere" }}>
      {account && <p>You’re signed in as {account}.</p>}
      <p>{WRONG_ACCOUNT_DEVICE_MESSAGE}</p>
      <button
        className="btn-secondary"
        type="button"
        disabled={busy}
        onClick={() => void switchAccount()}
      >
        {busy ? "Signing out…" : "Switch account"}
      </button>
      {error && <p>{error}</p>}
    </div>
  );
}
