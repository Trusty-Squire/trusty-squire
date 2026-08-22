"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { getPairingState, pairDevice } from "../../../lib/pairing";
import { getVouchflow } from "../../../lib/vouchflow";

interface EditableMetadata {
  label: string;
  allowed_hosts: string[];
  login_hosts: string[];
}

interface MutationCeremony {
  approval_id: string;
  status: "pending" | "approved" | "failed" | "expired";
  operation: "edit" | "delete";
  credential: { reference: string; service: string | null; name: string };
  before: EditableMetadata;
  after: EditableMetadata | null;
  expires_at: string;
  error?: string;
  payload: unknown;
  payload_sha256: string;
}

function Metadata({ value }: { value: EditableMetadata }) {
  return (
    <dl className="app-sub" style={{ margin: 0 }}>
      {[
        ["Name", value.label],
        ["Allowed hosts", value.allowed_hosts.join(", ") || "—"],
        ["Login hosts", value.login_hosts.join(", ") || "—"],
      ].map(([label, content]) => (
        <div
          key={label}
          style={{
            display: "grid",
            gridTemplateColumns: "max-content minmax(0, 1fr)",
            gap: "var(--s-2)",
            marginTop: "var(--s-2)",
          }}
        >
          <dt>{label}</dt>
          <dd className="mono" style={{ margin: 0, overflowWrap: "anywhere" }}>
            {content}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function CredentialMutationApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ceremony, setCeremony] = useState<MutationCeremony | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/mutate/${encodeURIComponent(id)}`);
  }, [id, router]);

  const fetchCeremony = useCallback(
    () =>
      apiGet<MutationCeremony>(`/v1/vault/mutation-approvals/${encodeURIComponent(id)}/ceremony`),
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchCeremony()
      .then((value) => {
        if (!cancelled) setCeremony(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Failed to load approval.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [fetchCeremony]);

  const approve = useCallback(async () => {
    if (ceremony === null || ceremony.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const pairing = await getPairingState();
      if (!pairing.enrolled) {
        setNeedsPasskeySetup(true);
        return;
      }
      const signed = await getVouchflow().signPayload({
        context: "vault_credential_mutation",
        payload: ceremony.payload,
        minConfidence: "low",
      });
      await apiPost(
        `/v1/vault/mutation-approvals/${encodeURIComponent(ceremony.approval_id)}/approve`,
        { jws: signed.assertion },
      );
      setCeremony(await fetchCeremony());
      setNeedsPasskeySetup(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }, [ceremony, fetchCeremony]);

  const setUpPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await apiGet("/v1/vault/e2e");
      await pairDevice();
      setNeedsPasskeySetup(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Failed to set up passkey.");
    } finally {
      setBusy(false);
    }
  }, [redirectToLogin]);

  const title =
    ceremony?.operation === "delete" ? "Approve credential deletion" : "Approve credential edit";
  const terminal =
    ceremony?.status === "approved"
      ? "Approved — the vault mutation is complete. You can return to your agent session."
      : ceremony?.status === "expired"
        ? "This credential mutation approval has expired."
        : ceremony?.status === "failed"
          ? `The vault refused this mutation${ceremony.error ? `: ${ceremony.error}` : "."}`
          : null;

  return (
    <AppShell anonymous>
      <div className="app-head">
        <div>
          <h1 className="app-title">{title}</h1>
          <p className="app-sub">
            Review the exact target and metadata change, then confirm with your passkey.
          </p>
        </div>
      </div>

      {error !== null && <div className="app-banner err">{error}</div>}
      {ceremony === null && error === null && <p className="app-sub">Loading…</p>}
      {terminal !== null && (
        <div className={`app-banner ${ceremony?.status === "approved" ? "ok" : ""}`}>
          {terminal}
        </div>
      )}

      {ceremony !== null && (
        <section className="app-card" aria-labelledby="credential-target">
          <h2 className="app-title" id="credential-target" style={{ fontSize: "var(--t-lg)" }}>
            {ceremony.credential.service ?? "Credential"} · {ceremony.credential.name}
          </h2>
          <p className="mono app-sub" style={{ overflowWrap: "anywhere", marginTop: "var(--s-3)" }}>
            {ceremony.credential.reference}
          </p>

          <div style={{ marginTop: "var(--s-6)" }}>
            <p className="sect-label">Before</p>
            <Metadata value={ceremony.before} />
          </div>
          {ceremony.after !== null && (
            <div style={{ marginTop: "var(--s-6)" }}>
              <p className="sect-label">After</p>
              <Metadata value={ceremony.after} />
            </div>
          )}
          {ceremony.operation === "delete" && (
            <div className="app-banner err" style={{ marginTop: "var(--s-6)" }}>
              This removes the credential from agent use. The secret value is never shown.
            </div>
          )}

          {ceremony.status === "pending" &&
            (needsPasskeySetup ? (
              <button
                className="btn-primary"
                type="button"
                onClick={() => void setUpPasskey()}
                disabled={busy}
              >
                {busy ? "Setting up…" : "Sign in and set up passkey"}
              </button>
            ) : (
              <button
                className="btn-primary"
                type="button"
                onClick={() => void approve()}
                disabled={busy}
              >
                {busy
                  ? "Approving…"
                  : ceremony.operation === "delete"
                    ? "Approve deletion"
                    : "Approve edit"}
              </button>
            ))}
        </section>
      )}
    </AppShell>
  );
}
