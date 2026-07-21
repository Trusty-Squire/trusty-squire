"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "../components/AppShell";
import { Modal } from "../components/Modal";
import { CredentialFields, type FieldsResult } from "../components/CredentialFields";
import { parseHostList } from "../lib/hosts";
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
  // Per-entry name within a service ("default" unless renamed). Lets the
  // user distinguish multiple entries under one service.
  label: string;
  // Plaintext names of the secret fields (NOT the values).
  field_names: string[];
  key_name: string | null;
  type: string;
  allowed_hosts: string[];
  // username/password login creds: how they're stored + where they may be
  // browser-filled. login_hosts (not allowed_hosts) is the meaningful host list
  // for a login. Server returns these off metadata.
  auth_strategy: string | null;
  login_hosts: string[];
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
          <Link className="icon-btn" href="/vault/settings" aria-label="Settings" title="Settings">
            <GearIcon />
          </Link>
          <Link className="add-btn" href="/vault/new" aria-label="Add key" title="Add key">
            +
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
              <VaultRow
                key={cred.id}
                cred={cred}
                onDeleted={onDeleted}
                onChanged={() => {
                  void load();
                }}
              />
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

// One transient status chip per tile. Verify and copy share it, so their
// labels are mutually exclusive — copying clears a prior "decrypts", and
// verifying clears a prior "copied".
type Status = "idle" | "checking" | "ok" | "bad" | "copied" | "copyfail";

function VaultRow({
  cred,
  onDeleted,
  onChanged,
}: {
  cred: Cred;
  onDeleted: (cred: Cred) => void;
  onChanged: () => void;
}) {
  // Revealed secret is a name→value map: a lone key is { value: "…" },
  // AWS-style creds carry multiple named fields. null = not yet fetched.
  const [fields, setFields] = useState<Record<string, string> | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Status>("idle");

  // Fetch + cache the field map once; reveal and copy both need it.
  const ensureFields = useCallback(async (): Promise<Record<string, string> | null> => {
    if (fields !== null) return fields;
    setBusy(true);
    try {
      const res = await apiPost<{ fields: Record<string, string> }>(
        `/v1/vault/credentials/${cred.id}/reveal`,
      );
      setFields(res.fields);
      return res.fields;
    } catch {
      return null;
    } finally {
      setBusy(false);
    }
  }, [cred.id, fields]);

  const onReveal = useCallback(async () => {
    if (shown) {
      setShown(false);
      return;
    }
    const f = await ensureFields();
    if (f !== null) setShown(true);
  }, [shown, ensureFields]);

  const onCopy = useCallback(async () => {
    // A lone key copies its value; a multi-field cred copies env-style
    // `name=value` lines so nothing is silently dropped.
    const buildText = async (): Promise<string> => {
      const f = await ensureFields();
      if (f === null) throw new Error("reveal failed");
      const keys = Object.keys(f);
      return keys.length === 1 ? f[keys[0]!]! : keys.map((k) => `${k}=${f[k]!}`).join("\n");
    };
    // `writeText` AFTER awaiting the reveal loses the click's transient user
    // activation, so Safari/Firefox (and Chrome past the activation window)
    // silently reject the write — that's why Copy did nothing on first use
    // (revealing first cached the fields, masking it). The ClipboardItem
    // Promise form registers the write synchronously in the gesture and fills
    // it from the async reveal, so activation holds.
    try {
      if (typeof ClipboardItem !== "undefined") {
        const blob = buildText().then((t) => new Blob([t], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else {
        await navigator.clipboard.writeText(await buildText());
      }
      setStatus("copied");
      // Clear only if still "copied" — don't clobber a verify that ran
      // in the meantime.
      setTimeout(() => setStatus((s) => (s === "copied" ? "idle" : s)), 1400);
    } catch {
      // Surface the failure — the old silent catch is exactly what hid this.
      setStatus("copyfail");
      setTimeout(() => setStatus((s) => (s === "copyfail" ? "idle" : s)), 1800);
    }
  }, [ensureFields]);

  const onVerify = useCallback(async () => {
    setStatus("checking");
    try {
      const res = await apiPost<{ healthy: boolean }>(
        `/v1/vault/credentials/${cred.id}/health`,
      );
      setStatus(res.healthy ? "ok" : "bad");
    } catch {
      setStatus("bad");
    }
  }, [cred.id]);

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
          {cred.label !== "default" && (
            <span className="badge-label" title="Entry name">
              {cred.label}
            </span>
          )}
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
        <div className="secret">
          {shown && fields !== null ? (
            <span className="vals">
              {entries.map(([name, val]) => (
                <span className="val-line" key={name}>
                  {multiField && <span className="field-name">{name}</span>}
                  <span className="val">{val}</span>
                </span>
              ))}
            </span>
          ) : (
            <span className="mask">{busy ? "revealing…" : "••••••••••••••••"}</span>
          )}
          {status === "ok" && (
            <span className="health-ok" title="Decrypts cleanly under the current master key.">✓ decrypts</span>
          )}
          {status === "bad" && (
            <span className="health-bad" title="The stored envelope did not decrypt.">✗ decrypt failed</span>
          )}
          {status === "checking" && <span className="health-ok">checking…</span>}
          {status === "copied" && <span className="health-ok">copied ✓</span>}
          {status === "copyfail" && (
            <span className="health-bad" title="Clipboard write was blocked by the browser.">copy failed</span>
          )}
        </div>
      </div>

      <RowMenu
        label={`Actions for ${cred.service ?? "credential"}`}
        items={[
          { key: "reveal", label: shown ? "Hide" : "Reveal", onClick: onReveal },
          { key: "copy", label: "Copy", onClick: onCopy },
          { key: "verify", label: "Verify", onClick: onVerify },
          { key: "edit", label: "Edit", onClick: () => setEditing(true) },
          { key: "delete", label: "Delete", onClick: () => setConfirmDelete(true), danger: true },
        ]}
      />

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

      {editing && (
        <EditModal
          cred={cred}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            // Fields/label/hosts may have changed — drop the cached reveal
            // so the next one re-fetches, and reload the list.
            setFields(null);
            setShown(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

interface MenuItem {
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

// Per-tile overflow menu (kebab). Collapses reveal / copy / verify / delete
// into one control. Closes on item click, outside click, or Escape.
function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="kebab"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        ⋮
      </button>
      {open && (
        <div className="row-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              className={it.danger === true ? "danger" : ""}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
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

// Shallow equality for a field name→value map (skip a needless rotate when
// the secrets weren't actually changed).
function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => b[k] === a[k]);
}

// One editor for everything mutable on a credential. Mirrors the New
// credential page, but PRE-POPULATED: the current field name/value pairs
// are revealed and loaded in, you add/remove fields inline, and the entry
// name + allowed hosts live under Advanced. Replaces the old Rename /
// Add field / Edit hosts actions. Saves only what changed.
function EditModal({
  cred,
  onClose,
  onSaved,
}: {
  cred: Cred;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Field editing is delegated to the shared <CredentialFields> editor; it
  // reports the current map up here. origMap is the revealed starting point,
  // used both to seed the editor and to detect whether the fields changed.
  const [origMap, setOrigMap] = useState<Record<string, string> | null>(null);
  const [fields, setFields] = useState<FieldsResult>({ map: null, error: null });
  // A username/password login (browser-filled on sign-in hosts) vs an API key
  // (spent through the proxy). The host list the user cares about differs:
  // login_hosts for a login, allowed_hosts for a key. Detect a login by its
  // auth_strategy, or — for a plain multi-field entry stored without one (id +
  // password, login_hosts empty) — by the presence of a password-shaped field.
  const isLogin =
    cred.auth_strategy === "username_password" ||
    cred.field_names.some((n) => /^(password|pass|passwd|secret)$/i.test(n));
  const relevantHosts = isLogin ? cred.login_hosts : cred.allowed_hosts;
  // Advanced: entry name + hosts. Auto-open when the meaningful host list is
  // empty — that's the thing the user came to fix.
  const [advanced, setAdvanced] = useState(relevantHosts.length === 0);
  const [label, setLabel] = useState(cred.label === "default" ? "" : cred.label);
  const [hostsText, setHostsText] = useState(relevantHosts.join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reveal current values so the form opens pre-populated. Same trust as the
  // Reveal action (the user's own vault, web-session-authed). Async, so no
  // synchronous set-state-in-effect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiPost<{ fields: Record<string, string> }>(
          `/v1/vault/credentials/${cred.id}/reveal`,
        );
        if (cancelled) return;
        setOrigMap(res.fields);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Couldn't load this credential.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cred.id]);

  const save = useCallback(async () => {
    // Build the full field map from the shared editor. PATCH /:id REPLACES the
    // map, so this one call covers value edits, renames, adds, and removes.
    const map = fields.map;
    if (map === null) {
      setError(fields.error ?? "Add at least one field with a value.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 1. Label.
      const nextLabel = label.trim() === "" ? "default" : label.trim();
      if (nextLabel !== cred.label) {
        await apiPatch(`/v1/vault/credentials/${cred.id}/label`, { label: nextLabel });
      }
      // 2. Hosts — sign-in hosts (login_hosts) for a login, allowed hosts for a
      //    key. Same textarea, different field + endpoint by credential kind.
      const hosts = parseHostList(hostsText);
      const prevHosts = isLogin ? cred.login_hosts : cred.allowed_hosts;
      const hostsChanged =
        hosts.length !== prevHosts.length || hosts.some((h, i) => h !== prevHosts[i]);
      if (hostsChanged) {
        const path = isLogin ? "login-hosts" : "allowed-hosts";
        await apiPatch(`/v1/vault/credentials/${cred.id}/${path}`, { hosts });
      }
      // 3. Fields — only if they actually changed (avoid a needless rotate).
      if (origMap === null || !sameMap(map, origMap)) {
        await apiPatch(`/v1/vault/credentials/${cred.id}`, { fields: map });
      }
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError("One of the hosts isn't valid — use a bare hostname like api.example.com (no https://, no path).");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't save your changes.");
      }
      setBusy(false);
    }
  }, [cred, fields, origMap, label, hostsText, isLogin, onSaved]);

  return (
    <Modal
      title={`Edit ${cred.service ?? "credential"}`}
      subtitle="The current values are loaded in — change them, add or remove fields, or edit the entry name and allowed hosts under Advanced."
      onClose={onClose}
    >
      <div className="form">
        {error !== null && <div className="form-err">{error}</div>}

        {loading && <p className="hint">Loading current values…</p>}
        {!loading && loadError !== null && <div className="form-err">{loadError}</div>}
        {!loading && loadError === null && (
          <>
            <CredentialFields
              idPrefix={`edit-${cred.id}`}
              initialFields={origMap}
              onChange={setFields}
            />

            <button type="button" className="disclose" onClick={() => setAdvanced((a) => !a)}>
              {advanced ? "▾" : "▸"} Advanced
            </button>
            {advanced && (
              <>
                <div className="field">
                  <label htmlFor={`edit-label-${cred.id}`}>Label</label>
                  <input
                    id={`edit-label-${cred.id}`}
                    className="mono"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="default"
                    maxLength={60}
                    autoComplete="off"
                  />
                  <span className="field-hint">Tells entries of the same service apart (prod/dev).</span>
                </div>
                <div className="field">
                  <label htmlFor={`edit-hosts-${cred.id}`}>
                    {isLogin ? "Sign-in hosts" : "Allowed hosts"}
                  </label>
                  <textarea
                    id={`edit-hosts-${cred.id}`}
                    className="mono"
                    value={hostsText}
                    onChange={(e) => setHostsText(e.target.value)}
                    placeholder={isLogin ? "clubgg.com" : "api.example.com"}
                    rows={3}
                    autoComplete="off"
                  />
                  <span className="field-hint">
                    {isLogin
                      ? "Sign-in pages where Trusty Squire may fill this login. One per line; empty = unusable until you add one."
                      : "use_credential can only call these hosts. One per line; empty = unusable until you add one."}
                  </span>
                </div>
              </>
            )}

            <div className="form-actions">
              <button className="btn-primary" type="button" onClick={save} disabled={busy}>
                {busy ? "Saving…" : "Save changes"}
              </button>
              <button className="btn-secondary" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// Settings gear — outline icon button in the header, next to the "+".
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
