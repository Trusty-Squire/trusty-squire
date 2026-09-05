"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { getPairingState, pairDevice } from "../../../lib/pairing";
import { getVouchflow } from "../../../lib/vouchflow";

interface FetchCeremony {
  approval_id: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired" | "failed";
  credential: { reference: string; service: string | null; name: string };
  field: string | null;
  field_names: string[];
  expires_at: string;
  error?: string;
  payload: unknown;
  payload_sha256: string;
}

export default function CredentialFetchApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ceremony, setCeremony] = useState<FetchCeremony | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/fetch/${encodeURIComponent(id)}`);
  }, [id, router]);

  const fetchCeremony = useCallback(
    () => apiGet<FetchCeremony>(`/v1/vault/fetch-approvals/${encodeURIComponent(id)}/ceremony`),
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    void fetchCeremony()
      .then((value) => {
        if (!cancelled) setCeremony(value);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        // The ceremony is owner-authenticated now: an approval link opened in a
        // signed-out browser is a login, not an error. `next` brings the human
        // straight back to the approval they were sent.
        if (caught instanceof ApiError && caught.status === 401) {
          redirectToLogin();
          return;
        }
        setError(caught instanceof Error ? caught.message : "Failed to load approval.");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchCeremony, redirectToLogin]);

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
        context: "vault_credential_fetch",
        payload: ceremony.payload,
        minConfidence: "low",
      });
      await apiPost(`/v1/vault/fetch-approvals/${encodeURIComponent(ceremony.approval_id)}/approve`, {
        jws: signed.assertion,
      });
      setCeremony(await fetchCeremony());
      setNeedsPasskeySetup(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }, [ceremony, fetchCeremony, redirectToLogin]);

  const deny = useCallback(async () => {
    if (ceremony === null || ceremony.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/v1/vault/fetch-approvals/${encodeURIComponent(ceremony.approval_id)}/deny`, {});
      setCeremony(await fetchCeremony());
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Denial failed.");
    } finally {
      setBusy(false);
    }
  }, [ceremony, fetchCeremony, redirectToLogin]);

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

  const terminal =
    ceremony?.status === "approved"
      ? "Approved — the agent can now read this secret once. You can return to your agent session."
      : ceremony?.status === "consumed"
        ? "The agent has read this secret. This approval is spent and cannot be used again."
        : ceremony?.status === "denied"
          ? "Denied — no value was released."
          : ceremony?.status === "expired"
            ? "This fetch approval has expired. No value was released."
            : ceremony?.status === "failed"
              ? `The vault refused this fetch${ceremony.error ? `: ${ceremony.error}` : "."}`
              : null;

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Approve revealing a secret</h1>
          <p className="app-sub">
            Approving hands the raw value to the agent that asked for it. Do this only if the
            agent needs to write the key somewhere itself.
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
            <p className="sect-label">Field to reveal</p>
            <p className="mono app-sub" style={{ margin: 0, overflowWrap: "anywhere" }}>
              {ceremony.field ?? ceremony.field_names.join(", ") ?? "—"}
            </p>
          </div>

          <div className="app-banner err" style={{ marginTop: "var(--s-6)" }}>
            The agent will see this value in clear, and it will stay in that conversation&apos;s
            transcript. It can be read once — this approval is spent on first delivery.
          </div>

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
              <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => void approve()}
                  disabled={busy}
                >
                  {busy ? "Approving…" : "Approve reveal"}
                </button>
                <button type="button" onClick={() => void deny()} disabled={busy}>
                  Deny
                </button>
              </div>
            ))}
        </section>
      )}
    </AppShell>
  );
}
