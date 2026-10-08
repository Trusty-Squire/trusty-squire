"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AppShell } from "../../../components/AppShell";
import { PasskeySetup } from "../../../components/PasskeySetup";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { errorText } from "../../../lib/error-text";
import {
  approvalErrorMessage,
  getPairingState,
  isUnlinkedSigningDevice,
  pairDevice,
  registerEnrolledDevice,
  WRONG_ACCOUNT_DEVICE_MESSAGE,
} from "../../../lib/pairing";
import { getVouchflow } from "../../../lib/vouchflow";
import { consequenceLine, revealQuestion } from "./copy";

interface FetchCeremony {
  approval_id: string;
  status: "pending" | "approved" | "consumed" | "denied" | "expired" | "failed";
  credential: { reference: string; service: string | null; name: string };
  field: string | null;
  field_names: string[];
  agent: string;
  reason: string | null;
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

  // A signed-in browser opening this link claims its passkey here, so an
  // already-enrolled owner never has to detour through the vault to answer an
  // approval. Without a session the endpoint refuses and nothing is claimed.
  const [deviceClaimed, setDeviceClaimed] = useState(false);
  useEffect(() => {
    void registerEnrolledDevice().then(setDeviceClaimed, () => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCeremony()
      .then((value) => {
        if (!cancelled) setCeremony(value);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(errorText(caught, "Failed to load approval."));
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
        context: "vault_credential_fetch",
        payload: ceremony.payload,
        minConfidence: "low",
      });
      await apiPost(
        `/v1/vault/fetch-approvals/${encodeURIComponent(ceremony.approval_id)}/approve`,
        { jws: signed.assertion },
      );
      setCeremony(await fetchCeremony());
      setNeedsPasskeySetup(false);
    } catch (caught) {
      // An unclaimed passkey on a signed-OUT browser is recoverable: signing in
      // claims it on the way back. Once the claim HAS landed, the same refusal
      // means the session is a different account, so bouncing to login again
      // would only repeat itself.
      if (isUnlinkedSigningDevice(caught)) {
        if (deviceClaimed) {
          setError(WRONG_ACCOUNT_DEVICE_MESSAGE);
          return;
        }
        redirectToLogin();
        return;
      }
      setError(approvalErrorMessage(caught, "Approval failed."));
    } finally {
      setBusy(false);
    }
  }, [ceremony, deviceClaimed, fetchCeremony, redirectToLogin]);

  const deny = useCallback(async () => {
    if (ceremony === null || ceremony.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(
        `/v1/vault/fetch-approvals/${encodeURIComponent(ceremony.approval_id)}/deny`,
        {},
      );
      setCeremony(await fetchCeremony());
    } catch (caught) {
      setError(errorText(caught, "Denial failed."));
    } finally {
      setBusy(false);
    }
  }, [ceremony, fetchCeremony]);

  const setUpPasskey = useCallback(async (forceNew: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await apiGet("/v1/vault/e2e");
      await pairDevice({ forceNew });
      // Setting up here needed a session (the /v1/vault/e2e probe above), so
      // this is the moment the new device can be claimed for the account — and
      // a claim that lands here counts, or the next refusal would send a human
      // who already has a session back through login for nothing.
      setDeviceClaimed(await registerEnrolledDevice());
      setNeedsPasskeySetup(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      throw caught;
    } finally {
      setBusy(false);
    }
  }, [redirectToLogin]);

  const releasedFieldCount =
    ceremony === null ? 1 : ceremony.field === null ? ceremony.field_names.length : 1;
  const terminal =
    ceremony?.status === "approved"
      ? `Approved — the agent can now read ${releasedFieldCount === 1 ? "this secret" : "these secrets"} once. You can return to your agent session.`
      : ceremony?.status === "consumed"
        ? `The agent has read ${releasedFieldCount === 1 ? "this secret" : "these secrets"}. This approval is spent and cannot be used again.`
        : ceremony?.status === "denied"
          ? "Denied — no value was released."
          : ceremony?.status === "expired"
            ? "This fetch approval has expired. No value was released."
            : ceremony?.status === "failed"
              ? `The vault refused this fetch${ceremony.error ? `: ${ceremony.error}` : "."}`
              : null;
  const pending = ceremony?.status === "pending";
  const question =
    ceremony === null
      ? null
      : revealQuestion(ceremony.credential, ceremony.field, ceremony.field_names);

  return (
    <AppShell anonymous>
      {pending && question !== null && (
        <div className="app-head">
          <div>
            <h1 className="app-title" id="credential-target">
              {question}
            </h1>
          </div>
        </div>
      )}

      {error !== null && <div className="app-banner err">{error}</div>}
      {ceremony === null && error === null && <p className="app-sub">Loading…</p>}
      {terminal !== null && (
        <h1 className={`app-banner ${ceremony?.status === "approved" ? "ok" : ""}`}>{terminal}</h1>
      )}

      {pending && ceremony !== null && (
        <section className="app-card" aria-labelledby="credential-target">
          <p className="app-sub" style={{ marginTop: 0, overflowWrap: "anywhere" }}>
            Requested by {ceremony.agent}
          </p>
          {ceremony.reason !== null && (
            <dl className="app-sub" style={{ margin: "var(--s-3) 0 0" }}>
              <dt>Reason given</dt>
              <dd className="mono" style={{ margin: "var(--s-2) 0 0", overflowWrap: "anywhere" }}>
                “{ceremony.reason}”
              </dd>
            </dl>
          )}
          <p className="app-sub" style={{ marginTop: "var(--s-3)" }}>
            {consequenceLine(ceremony.expires_at, Date.now(), releasedFieldCount)}
          </p>

          {needsPasskeySetup ? (
            <PasskeySetup onSetup={setUpPasskey} busy={busy} />
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
              <button
                className="btn-deny"
                type="button"
                onClick={() => void deny()}
                disabled={busy}
              >
                Deny
              </button>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}
