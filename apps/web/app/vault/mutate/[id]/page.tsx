"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { WrongAccountNotice } from "../../../components/WrongAccountNotice";
import { ApprovalFrame, useApprovalEmbed } from "../../../components/ApprovalFrame";
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
import {
  hostStatus,
  isFramePasskeyFailure,
  passkeysAllowedHere,
} from "../../../lib/approval-embed";

interface EditableMetadata {
  label: string;
  allowed_hosts: string[];
  login_hosts: string[];
  auth_strategy: string | null;
}

interface MutationCeremony {
  approval_id: string;
  status: "pending" | "approved" | "failed" | "denied" | "expired";
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
        ["Authentication", value.auth_strategy ?? "—"],
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

  const fetchCeremony = useCallback(
    () =>
      apiGet<MutationCeremony>(`/v1/vault/mutation-approvals/${encodeURIComponent(id)}/ceremony`),
    [id],
  );
  const embedState = useApprovalEmbed(
    id,
    useCallback(async () => setCeremony(await fetchCeremony()), [fetchCeremony]),
  );
  const { embed, requireWindow, loginUrl, leave } = embedState;
  const inSheet = embed?.mode === "sheet";

  // Sign-in cannot complete inside another app's sheet; a window of our own can.
  const redirectToLogin = useCallback(() => {
    if (inSheet) {
      requireWindow();
      return;
    }
    router.replace(loginUrl(`/vault/mutate/${encodeURIComponent(id)}`));
  }, [id, inSheet, loginUrl, requireWindow, router]);

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
      if (inSheet && !passkeysAllowedHere()) {
        requireWindow();
        return;
      }
      const pairing = await getPairingState();
      if (!pairing.enrolled) {
        if (inSheet) requireWindow();
        else setNeedsPasskeySetup(true);
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
      if (inSheet && isFramePasskeyFailure(caught)) {
        requireWindow();
        return;
      }
      setError(approvalErrorMessage(caught, "Approval failed."));
    } finally {
      setBusy(false);
    }
  }, [ceremony, deviceClaimed, fetchCeremony, inSheet, redirectToLogin, requireWindow]);

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

  const title =
    ceremony?.operation === "delete" ? "Approve credential deletion" : "Approve credential edit";
  const terminal =
    ceremony?.status === "approved"
      ? "Approved — the vault mutation is complete. You can return to your agent session."
      : ceremony?.status === "denied"
        ? "Denied — no change was made."
        : ceremony?.status === "expired"
        ? "This credential mutation approval has expired."
        : ceremony?.status === "failed"
          ? `The vault refused this mutation${ceremony.error ? `: ${ceremony.error}` : "."}`
          : null;

  return (
    <ApprovalFrame
      state={embedState}
      approvalId={id}
      status={ceremony === null ? null : hostStatus("credential_mutation", ceremony.status)}
    >
      <div className="app-head">
        <div>
          <h1 className="app-title">{title}</h1>
          <p className="app-sub">
            Review the exact target and metadata change, then confirm with your passkey.
          </p>
        </div>
      </div>

      {error === WRONG_ACCOUNT_DEVICE_MESSAGE ? (
        <WrongAccountNotice approvalPath={`/vault/mutate/${encodeURIComponent(id)}`} />
      ) : error !== null ? (
        <div className="app-banner err">{error}</div>
      ) : null}
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

          {ceremony.status === "pending" && (
            <>
              <div className="approval-actions">
                {needsPasskeySetup ? (
                  <PasskeySetup onSetup={setUpPasskey} busy={busy} />
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
                )}
                <button
                  className="btn-secondary"
                  type="button"
                  onClick={() => {
                    if (!leave("pending")) router.push("/");
                  }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
              <p className="app-sub">Cancel leaves this request pending until it expires.</p>
            </>
          )}
        </section>
      )}
    </ApprovalFrame>
  );
}
