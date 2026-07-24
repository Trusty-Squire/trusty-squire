"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { Modal } from "../../components/Modal";
import { ApiError, apiDelete, apiGet, apiPost } from "../../lib/api";

export default function SettingsPage() {
  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Settings</h1>
          <p className="app-sub">Export your data, or delete your account.</p>
        </div>
        <div className="app-head-actions">
          <Link className="head-btn" href="/vault">
            ← Vault
          </Link>
        </div>
      </div>
      <TelegramSection />
      <DangerZone />
    </AppShell>
  );
}

// Poll cadence while waiting for the user to tap /start in Telegram after
// opening the deep link — light enough to not matter, fast enough to feel live.
const TG_POLL_INTERVAL_MS = 3000;
const TG_POLL_TIMEOUT_MS = 30000;

// Payment-approval push notifications via Telegram. Same hairline-ruled
// section pattern as the danger zone, one row.
function TelegramSection() {
  const router = useRouter();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const checkStatus = useCallback(async (): Promise<boolean> => {
    const res = await apiGet<{ connected: boolean }>("/v1/telegram/status");
    setConnected(res.connected);
    return res.connected;
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await checkStatus();
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/settings");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load Telegram status.");
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(pollTimer.current);
    };
  }, [checkStatus, router]);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<{ url: string }>("/v1/telegram/link");
      window.open(res.url, "_blank");

      const startedAt = Date.now();
      const poll = async (): Promise<void> => {
        try {
          const isConnected = await checkStatus();
          if (isConnected || Date.now() - startedAt >= TG_POLL_TIMEOUT_MS) return;
          pollTimer.current = setTimeout(() => void poll(), TG_POLL_INTERVAL_MS);
        } catch {
          // Transient poll failure — the initial load already surfaced auth
          // errors; just stop polling silently.
        }
      };
      pollTimer.current = setTimeout(() => void poll(), TG_POLL_INTERVAL_MS);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login?next=/vault/settings");
        return;
      }
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }, [checkStatus, router]);

  return (
    <section className="danger-zone">
      <div className="dz-head">Notifications</div>
      <div className="dz-row">
        <div>
          <div className="dz-title">Telegram</div>
          <div className="dz-sub">
            {connected === true
              ? "Telegram connected ✓"
              : "Get payment-approval links pushed to your phone via Telegram — no app beyond Telegram."}
          </div>
          {error !== null && <div className="dz-sub">{error}</div>}
        </div>
        {connected === false && (
          <button className="dz-btn" type="button" onClick={connect} disabled={busy}>
            {busy ? "Opening…" : "Connect Telegram"}
          </button>
        )}
      </div>
    </section>
  );
}

// Account-level actions: data export + the two destructive operations.
// Hairline-ruled rows, not cards — destructive paths gated behind a modal
// that requires typing the confirm word.
function DangerZone() {
  const [modal, setModal] = useState<null | "delete">(null);

  return (
    <section className="danger-zone">
      <div className="dz-head">Account</div>
      <div className="dz-row">
        <div>
          <div className="dz-title">Export my data</div>
          <div className="dz-sub">All credential metadata + the full activity log. No secret values.</div>
        </div>
        {/* A plain link: the endpoint sets content-disposition: attachment,
            so the browser downloads rather than navigates. */}
        <a className="head-btn" href="/v1/vault/export" download>
          Download
        </a>
      </div>
      <div className="dz-row">
        <div>
          <div className="dz-title">Delete my account</div>
          <div className="dz-sub">Permanently delete your account, every credential, and the activity log, and sign you out. Cannot be undone.</div>
        </div>
        <button className="dz-btn danger" type="button" onClick={() => setModal("delete")}>
          Delete account
        </button>
      </div>

      {modal === "delete" && (
        <ConfirmDangerModal
          title="Permanently delete your account?"
          subtitle="Your account, every credential, and the entire activity log are erased for good, and you'll be signed out. There is no undo. Export first if you want a copy."
          confirmWord="DELETE"
          actionLabel="Delete my account"
          run={async () => {
            await apiDelete("/v1/vault/account", { confirm: true });
            window.location.assign("/");
          }}
          onClose={() => setModal(null)}
        />
      )}
    </section>
  );
}

// Destructive confirm: requires typing the confirm word, mirroring the
// server's { confirm: true } guard with a human-side speed bump.
function ConfirmDangerModal({
  title,
  subtitle,
  confirmWord,
  actionLabel,
  run,
  onClose,
}: {
  title: string;
  subtitle: string;
  confirmWord: string;
  actionLabel: string;
  run: () => Promise<void>;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed.trim().toUpperCase() === confirmWord;

  const go = useCallback(async () => {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      setBusy(false);
    }
  }, [armed, run]);

  return (
    <Modal title={title} subtitle={subtitle} onClose={onClose}>
      <div className="form">
        {error !== null && <div className="form-err">{error}</div>}
        <label className="dz-confirm">
          <span>
            Type <code>{confirmWord}</code> to confirm
          </span>
          <input
            className="dz-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <div className="form-actions">
          <button className="btn-deny" type="button" onClick={go} disabled={!armed || busy}>
            {busy ? "Working…" : actionLabel}
          </button>
          <button className="btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
