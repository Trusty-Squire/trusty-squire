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
          <VaultRow key={cred.id} cred={cred} onDeleted={onDeleted} />
        ))}
    </AppShell>
  );
}

function VaultRow({
  cred,
  onDeleted,
}: {
  cred: Cred;
  onDeleted: (id: string) => void;
}) {
  // Revealed secret is a name→value map: a lone key is { value: "…" },
  // AWS-style creds carry multiple named fields. null = still masked.
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reveal = useCallback(async () => {
    setBusy(true);
    try {
      // The reveal endpoint returns { fields }, not a bare value — read
      // the map so single- and multi-field credentials both render.
      const res = await apiPost<{ fields: Record<string, string> }>(
        `/v1/vault/credentials/${cred.id}/reveal`,
      );
      setFields(res.fields);
    } catch {
      /* leave masked on failure */
    } finally {
      setBusy(false);
    }
  }, [cred.id]);

  const copy = useCallback(async (key: string, val: string) => {
    try {
      await navigator.clipboard.writeText(val);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }, []);

  const entries = fields === null ? [] : Object.entries(fields);
  const multiField = entries.length > 1;

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
        {fields === null ? (
          <div className="secret">
            <span className="mask">••••••••••••••••••</span>
            <button
              className="linkbtn"
              type="button"
              onClick={reveal}
              disabled={busy}
            >
              {busy ? "revealing…" : "reveal"}
            </button>
          </div>
        ) : (
          entries.map(([name, val]) => (
            <div className="secret" key={name}>
              {multiField && <span className="field-name">{name}</span>}
              <span className="val">{val}</span>
              <button
                className="linkbtn"
                type="button"
                onClick={() => copy(name, val)}
              >
                {copiedKey === name ? "copied" : "copy"}
              </button>
            </div>
          ))
        )}
      </div>

      <div className="row-action">
        <button
          className="pill-btn danger"
          type="button"
          onClick={() => setConfirmDelete(true)}
        >
          Delete
        </button>
      </div>

      {confirmDelete && (
        <DeleteModal
          cred={cred}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => {
            setConfirmDelete(false);
            onDeleted(cred.id);
          }}
        />
      )}
    </div>
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
      title={`Delete the ${cred.service ?? "credential"} key?`}
      subtitle="Your squire and any agents using it lose access right away. You can add it back later if you still have the key."
      onClose={onClose}
    >
      <div className="form">
        {error !== null && <div className="form-err">{error}</div>}
        <div className="form-actions">
          <button className="btn-deny" type="button" onClick={del} disabled={busy}>
            {busy ? "Deleting…" : "Delete key"}
          </button>
          <button className="btn-secondary" type="button" onClick={onClose}>
            Keep it
          </button>
        </div>
      </div>
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
