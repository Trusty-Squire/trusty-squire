"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { ApiError, apiGet, apiPost, timeAgo } from "../lib/api";

interface Cred {
  id: string;
  service: string | null;
  key_name: string | null;
  type: string;
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

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Vault</h1>
          <p className="app-sub">Keys your squire has collected.</p>
        </div>
        {creds !== null && <span className="app-count">{creds.length}</span>}
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
            collects lands here. Run <code>npx @trusty-squire/mcp pair</code> to
            connect one.
          </p>
        </div>
      )}

      {creds !== null &&
        creds.map((cred) => <VaultRow key={cred.id} cred={cred} />)}
    </AppShell>
  );
}

function VaultRow({ cred }: { cred: Cred }) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

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

  return (
    <div className="row">
      <div className="row-glyph">
        <KeyGlyph />
      </div>
      <div className="row-main">
        <div className="row-title">{cred.service ?? "Unknown service"}</div>
        <div className="row-meta">
          <span>{cred.key_name ?? cred.type}</span>
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
    </div>
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
