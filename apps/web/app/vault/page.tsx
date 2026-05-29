"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/Modal";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  timeAgo,
} from "../lib/api";

interface Cred {
  id: string;
  service: string | null;
  key_name: string | null;
  type: string;
  allowed_hosts: string[];
  created_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
}

export default function VaultPage() {
  const router = useRouter();
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<{ credentials: Cred[] }>(
          "/v1/vault/credentials",
        );
        if (!cancelled) setCreds(res.credentials);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault");
          return;
        }
        setError(
          err instanceof Error ? err.message : "Failed to load your vault.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const onDeleted = useCallback((id: string) => {
    setCreds((prev) => prev?.filter((c) => c.id !== id) ?? prev);
  }, []);

  const onHostsChanged = useCallback((id: string, hosts: string[]) => {
    setCreds(
      (prev) =>
        prev?.map((c) => (c.id === id ? { ...c, allowed_hosts: hosts } : c)) ??
        prev,
    );
  }, []);

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Vault</h1>
          <p className="app-sub">Keys your squire has collected.</p>
        </div>
        <div className="app-head-actions">
          {creds !== null && <span className="app-count">{creds.length}</span>}
          <Link className="head-btn" href="/vault/new">
            + Add key
          </Link>
        </div>
      </div>

      {error !== null && (
        <div className="app-state">
          <div className="big">Couldn&apos;t load the vault</div>
          <p className="hint">{error}</p>
        </div>
      )}

      {error === null && creds === null && (
        <div className="app-state">
          <p className="hint">Loading…</p>
        </div>
      )}

      {creds !== null && creds.length === 0 && (
        <div className="app-state">
          <div className="big">No keys yet</div>
          <p className="hint">
            Pair a CLI and let your squire sign up for a service — every key it
            collects lands here. Or <Link href="/vault/new">add one by hand</Link>.
          </p>
        </div>
      )}

      {creds !== null &&
        creds.map((cred) => (
          <VaultRow
            key={cred.id}
            cred={cred}
            onDeleted={onDeleted}
            onHostsChanged={onHostsChanged}
          />
        ))}
    </AppShell>
  );
}

type RowModal = "rotate" | "delete" | "hosts" | null;

function VaultRow({
  cred,
  onDeleted,
  onHostsChanged,
}: {
  cred: Cred;
  onDeleted: (id: string) => void;
  onHostsChanged: (id: string, hosts: string[]) => void;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [modal, setModal] = useState<RowModal>(null);

  const reveal = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ value: string }>(
        `/v1/vault/credentials/${cred.id}/reveal`,
      );
      setValue(res.value);
    } catch {
      /* leave masked on failure */
    } finally {
      setBusy(false);
    }
  }, [cred.id]);

  const copy = useCallback(async () => {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, [value]);

  const openModal = useCallback((m: RowModal) => {
    setMenuOpen(false);
    setModal(m);
  }, []);

  return (
    <div className="row">
      <div className="row-glyph">
        <KeyGlyph />
      </div>
      <div className="row-main">
        <div className="row-title">{cred.service ?? "Unknown service"}</div>
        <div className="row-meta">
          <span>{cred.key_name ?? cred.type}</span>
          <span className="sep">·</span>
          <span>
            {cred.allowed_hosts.length === 0
              ? "no allowed hosts"
              : cred.allowed_hosts.join(", ")}
          </span>
          {cred.last_retrieved_at !== null && (
            <>
              <span className="sep">·</span>
              <span>used {timeAgo(cred.last_retrieved_at)}</span>
            </>
          )}
        </div>
        <div className="secret">
          {value === null ? (
            <>
              <span className="mask">••••••••••••••••••</span>
              <button
                className="linkbtn"
                type="button"
                onClick={reveal}
                disabled={busy}
              >
                {busy ? "revealing…" : "reveal"}
              </button>
            </>
          ) : (
            <>
              <span className="val">{value}</span>
              <button className="linkbtn" type="button" onClick={copy}>
                {copied ? "copied" : "copy"}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="row-action">
        <div className="menu-wrap">
          <button
            className="menu-trigger"
            type="button"
            aria-label="Credential actions"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="menu">
              <button type="button" onClick={() => openModal("rotate")}>
                Rotate value
              </button>
              <button type="button" onClick={() => openModal("hosts")}>
                Edit allowed hosts
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => openModal("delete")}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {modal === "rotate" && (
        <RotateModal cred={cred} onClose={() => setModal(null)} />
      )}
      {modal === "delete" && (
        <DeleteModal
          cred={cred}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setModal(null);
            onDeleted(cred.id);
          }}
        />
      )}
      {modal === "hosts" && (
        <HostsModal
          cred={cred}
          onClose={() => setModal(null)}
          onSaved={(hosts) => {
            setModal(null);
            onHostsChanged(cred.id, hosts);
          }}
        />
      )}
    </div>
  );
}

function RotateModal({ cred, onClose }: { cred: Cred; onClose: () => void }) {
  const [newValue, setNewValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (newValue.trim() === "") return;
      setBusy(true);
      setError(null);
      try {
        const res = await apiPatch<{ revoked_grant_count: number }>(
          `/v1/vault/credentials/${cred.id}`,
          { new_value: newValue },
        );
        setDone(res.revoked_grant_count);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Rotation failed.");
        setBusy(false);
      }
    },
    [cred.id, newValue],
  );

  return (
    <Modal
      title={`Rotate ${cred.service ?? "credential"}`}
      subtitle="The new value replaces the old one. Any persistent agent grants for this key are revoked — agents will need fresh approval."
      onClose={onClose}
    >
      {done !== null ? (
        <div className="form">
          <p className="modal-sub">
            Rotated. {done} persistent grant{done === 1 ? "" : "s"} revoked.
          </p>
          <div className="form-actions">
            <button className="btn-primary" type="button" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={submit}>
          <div className="field">
            <label htmlFor="newval">New value</label>
            <input
              id="newval"
              className="mono"
              type="password"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          {error !== null && <div className="form-err">{error}</div>}
          <div className="form-actions">
            <button className="btn-primary" type="submit" disabled={busy}>
              {busy ? "Rotating…" : "Rotate"}
            </button>
            <button className="btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function DeleteModal({
  cred,
  onClose,
  onDeleted,
}: {
  cred: Cred;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const del = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await apiDelete(`/v1/vault/credentials/${cred.id}`);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      setBusy(false);
    }
  }, [cred.id, onDeleted]);

  return (
    <Modal
      title={`Delete ${cred.service ?? "credential"}?`}
      subtitle="This permanently removes the credential from the vault. Irreversible."
      onClose={onClose}
    >
      <div className="form">
        {error !== null && <div className="form-err">{error}</div>}
        <div className="form-actions">
          <button className="btn-deny" type="button" onClick={del} disabled={busy}>
            {busy ? "Deleting…" : "Delete permanently"}
          </button>
          <button className="btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

function HostsModal({
  cred,
  onClose,
  onSaved,
}: {
  cred: Cred;
  onClose: () => void;
  onSaved: (hosts: string[]) => void;
}) {
  const [text, setText] = useState(cred.allowed_hosts.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const hosts = text
        .split("\n")
        .map((h) => h.trim())
        .filter((h) => h !== "");
      try {
        const res = await apiPatch<{ allowed_hosts: string[] }>(
          `/v1/vault/credentials/${cred.id}/allowed-hosts`,
          { hosts },
        );
        onSaved(res.allowed_hosts);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed.");
        setBusy(false);
      }
    },
    [cred.id, text, onSaved],
  );

  return (
    <Modal
      title="Allowed hosts"
      subtitle="One host per line. The use_credential proxy warns when an agent calls a host that isn't listed (advisory — it still proceeds for trusted sessions)."
      onClose={onClose}
    >
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="hosts">Hosts</label>
          <textarea
            id="hosts"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="api.openai.com"
          />
        </div>
        {error !== null && <div className="form-err">{error}</div>}
        <div className="form-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save hosts"}
          </button>
          <button className="btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="5.5" />
      <path d="M12.9 12.9L20 20M16.5 16.5l2.4-2.4" />
    </svg>
  );
}
