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
  // Brand domain for the favicon, derived server-side from the service
  // when allowed_hosts is empty (most existing creds). null = no icon.
  favicon_domain: string | null;
  created_at: string;
  last_retrieved_at: string | null;
  retrieval_count: number;
  // Rotation-age signal (server-computed). `stale` past
  // VAULT_ROTATION_STALE_DAYS; last_changed_at = rotated_at ?? created_at.
  rotated_at: string | null;
  last_changed_at: string;
  age_days: number;
  stale: boolean;
}

export default function VaultPage() {
  const router = useRouter();
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Cred | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const res = await apiGet<{ credentials: Cred[] }>("/v1/vault/credentials");
    setCreds(res.credentials);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await load();
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
  }, [router, load]);

  // Optimistic delete: drop the row immediately, surface a time-boxed
  // Undo that calls restore. The deleted credential is recoverable on the
  // server until a GDPR purge, so Undo is honest even past the banner.
  const onDeleted = useCallback((cred: Cred) => {
    setCreds((prev) => prev?.filter((c) => c.id !== cred.id) ?? prev);
    setUndo(cred);
  }, []);

  const restore = useCallback(async () => {
    if (undo === null) return;
    const target = undo;
    setUndo(null);
    try {
      await apiPost(`/v1/vault/credentials/${target.id}/restore`);
      await load();
    } catch {
      // restore conflict / already gone — reload to reflect truth
      await load().catch(() => undefined);
    }
  }, [undo, load]);

  // Auto-dismiss the Undo banner after a short window.
  useEffect(() => {
    if (undo === null) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Vault</h1>
          <p className="app-sub">Keys your squire has collected.</p>
        </div>
        <div className="app-head-actions">
          {creds !== null && <span className="app-count">{creds.length}</span>}
          <Link className="head-btn" href="/vault/activity">
            Activity
          </Link>
          <Link className="head-btn" href="/vault/new">
            + Add key
          </Link>
        </div>
      </div>

      {undo !== null && (
        <div className="undo-bar" role="status">
          <span>
            Deleted <b>{undo.service ?? "credential"}</b>.
          </span>
          <button type="button" className="linkbtn" onClick={restore}>
            Undo
          </button>
        </div>
      )}

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

      {creds !== null && creds.length > 0 && (
        <>
          <div className="vault-list">
            {creds.map((cred) => (
              <VaultRow key={cred.id} cred={cred} onDeleted={onDeleted} />
            ))}
          </div>
          {/* keyboard rail — static "fast" signal (no handlers wired) */}
          <div className="kbd" aria-hidden="true">
            <span className="key">R</span> reveal
            <span className="key">C</span> copy
            <span className="key">⌘K</span> search
          </div>
        </>
      )}

      {creds !== null && <DangerZone />}
    </AppShell>
  );
}

// The credential's first allowed host drives the favicon; the service
// name's first letter is the lettermark fallback. The lettermark renders
// behind the img and shows through when there's no host or the favicon
// 404s (the img is hidden on error).
function ServiceIcon({ cred }: { cred: Cred }) {
  const [imgFailed, setImgFailed] = useState(false);
  const domain = cred.favicon_domain;
  const letter = (cred.service ?? cred.key_name ?? "?").charAt(0).toUpperCase();
  const showImg = domain !== null && !imgFailed;
  return (
    <div className="ic">
      <span className="lm">{letter}</span>
      {/* Third-party favicon service; next/image's loader/domains config
          buys nothing for a 17px throwaway icon with a lettermark
          fallback, so a plain <img> is the right tool here. */}
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
          alt=""
          onError={() => setImgFailed(true)}
        />
      )}
    </div>
  );
}

type Health = "idle" | "checking" | "ok" | "bad";

function VaultRow({
  cred,
  onDeleted,
}: {
  cred: Cred;
  onDeleted: (cred: Cred) => void;
}) {
  // Revealed secret is a name→value map: a lone key is { value: "…" },
  // AWS-style creds carry multiple named fields. null = still masked.
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [health, setHealth] = useState<Health>("idle");

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

  const check = useCallback(async () => {
    setHealth("checking");
    try {
      const res = await apiPost<{ healthy: boolean }>(
        `/v1/vault/credentials/${cred.id}/health`,
      );
      setHealth(res.healthy ? "ok" : "bad");
    } catch {
      setHealth("bad");
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

  // mono meta: "{host} · used {ago} · added/rotated {age}d ago", host
  // omitted when the credential has no allowed hosts.
  const host = cred.allowed_hosts[0];
  const usage =
    cred.last_retrieved_at !== null
      ? `used ${timeAgo(cred.last_retrieved_at)}`
      : "never used";
  const ageLabel = `${cred.rotated_at !== null ? "rotated" : "added"} ${cred.age_days}d ago`;

  return (
    <div className="row">
      <ServiceIcon cred={cred} />
      <div>
        <div className="svc">
          {cred.service ?? "Unknown service"}
          {cred.stale && (
            <span className="badge-stale" title="Older than the rotation window — consider re-storing this key.">
              rotate
            </span>
          )}
        </div>
        <div className="meta">
          {host !== undefined && (
            <>
              <span>{host}</span>
              <span className="dot">·</span>
            </>
          )}
          <span>{usage}</span>
          <span className="dot">·</span>
          <span>{ageLabel}</span>
        </div>
        {fields === null ? (
          <div className="secret">
            <span className="mask">••••••••••••••••</span>
            <button
              className="linkbtn"
              type="button"
              onClick={reveal}
              disabled={busy}
            >
              {busy ? "revealing…" : "reveal"}
            </button>
            <HealthChip health={health} onCheck={check} />
          </div>
        ) : (
          <>
            {entries.map(([name, val]) => (
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
            ))}
            <div className="secret">
              <HealthChip health={health} onCheck={check} />
            </div>
          </>
        )}
      </div>

      <button
        className="del"
        type="button"
        onClick={() => setConfirmDelete(true)}
      >
        Delete
      </button>

      {confirmDelete && (
        <DeleteModal
          cred={cred}
          onClose={() => setConfirmDelete(false)}
          onDeleted={() => {
            setConfirmDelete(false);
            onDeleted(cred);
          }}
        />
      )}
    </div>
  );
}

// Quiet "verify" link → ✓/✗ after probing the envelope. This checks the
// credential still decrypts under the current master key, not whether the
// upstream service still accepts it.
function HealthChip({ health, onCheck }: { health: Health; onCheck: () => void }) {
  if (health === "ok") return <span className="health-ok" title="Decrypts cleanly under the current master key.">✓ decrypts</span>;
  if (health === "bad") return <span className="health-bad" title="The stored envelope did not decrypt.">✗ decrypt failed</span>;
  return (
    <button className="linkbtn q" type="button" onClick={onCheck} disabled={health === "checking"}>
      {health === "checking" ? "checking…" : "verify"}
    </button>
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
      subtitle="Your squire and any agents using it lose access right away. You can undo this, or add it back later if you still have the key."
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

// Account-level actions: data export + the two destructive operations.
// Kept visually quiet at the bottom of the page (a hairline-ruled
// "danger zone"), not a card — destructive paths gated behind a modal
// that requires typed/clicked confirmation.
function DangerZone() {
  const router = useRouter();
  const [modal, setModal] = useState<null | "revoke" | "erase">(null);

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
          <div className="dz-title">Revoke every key</div>
          <div className="dz-sub">Kill-switch if a key leaked. Soft — you can restore until purged.</div>
        </div>
        <button className="dz-btn" type="button" onClick={() => setModal("revoke")}>
          Revoke all
        </button>
      </div>
      <div className="dz-row">
        <div>
          <div className="dz-title">Delete all vault data</div>
          <div className="dz-sub">Permanently erase every credential and the activity log. Cannot be undone.</div>
        </div>
        <button className="dz-btn danger" type="button" onClick={() => setModal("erase")}>
          Erase
        </button>
      </div>

      {modal === "revoke" && (
        <ConfirmDangerModal
          title="Revoke every credential?"
          subtitle="Your squire and all agents lose access to every key immediately. This is recoverable — deleted keys can be restored until they're purged."
          confirmWord="REVOKE"
          actionLabel="Revoke all keys"
          run={async () => {
            await apiPost("/v1/vault/credentials/revoke-all", { confirm: true });
            router.refresh();
            window.location.assign("/vault");
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "erase" && (
        <ConfirmDangerModal
          title="Permanently delete all vault data?"
          subtitle="Every credential AND the entire activity log are erased for good. There is no undo. Export first if you want a copy."
          confirmWord="DELETE"
          actionLabel="Erase everything"
          run={async () => {
            await apiDelete("/v1/vault/account");
            window.location.assign("/vault");
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
