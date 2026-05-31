"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { AppShell } from "../../components/AppShell";
import { Modal } from "../../components/Modal";
import { apiDelete } from "../../lib/api";

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
      <DangerZone />
    </AppShell>
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
