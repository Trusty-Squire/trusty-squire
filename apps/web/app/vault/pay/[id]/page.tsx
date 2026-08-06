"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { decryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { sealToRecipient } from "@trusty-squire/vault/hpke";
import { AppShell } from "../../../components/AppShell";
import { CardEntry } from "../../../components/CardEntry";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { getPairingState, isPaymentPasskeyUnavailable, pairDevice } from "../../../lib/pairing";
import { getVouchflow } from "../../../lib/vouchflow";

interface CeremonyCard {
  blob: string;
}

interface CardDetails {
  brand: string | null;
  last4: string | null;
}

interface CeremonyApproval extends ApprovalDetails {
  id: string;
  status: string;
  card_ref: string | null;
  operator_pubkey: string;
  approval_payload_sha256: string | null;
  card: CeremonyCard | null;
}

interface ApprovalDetails {
  id: string;
  status: string;
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  card_ref: string | null;
  operator_pubkey: string;
  expires_at: string;
  item: string;
  reason: string;
  agent: string;
}

interface Approval extends ApprovalDetails {
  card: CardDetails;
}

interface StoredCard extends E2EBlob {
  prf_salt: string;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return fromBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function formatAmount(amountCents: number, currency: string): string {
  try {
    const formatter = new Intl.NumberFormat(undefined, { style: "currency", currency });
    const minorDigits = formatter.resolvedOptions().maximumFractionDigits;
    return minorDigits === undefined
      ? `${amountCents} ${currency} minor units`
      : formatter.format(amountCents / 10 ** minorDigits);
  } catch {
    return `${amountCents} ${currency} minor units`;
  }
}

export default function PaymentApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ceremony, setCeremony] = useState<CeremonyApproval | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState(false);
  const [savedCardId, setSavedCardId] = useState<string | null>(null);
  const [cardMetadataError, setCardMetadataError] = useState<string | null>(null);
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jitOrigin, setJitOrigin] = useState<boolean | null>(null);

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/pay/${encodeURIComponent(id)}`);
  }, [id, router]);

  const fetchCeremony = useCallback(
    () => apiGet<CeremonyApproval>(`/v1/pay/approvals/${encodeURIComponent(id)}/ceremony`),
    [id],
  );

  const applyCeremony = useCallback((current: CeremonyApproval) => {
    setJitOrigin((origin) => origin ?? current.card_ref === null);
    setCeremony(current);
    // Details are capability-link disclosure from the server record. Rendering
    // them never signs anything; the single payment signature happens only in
    // the explicit Approve payment handler below.
    setApproval({ ...current, card: { brand: null, last4: null } });
    setCardMetadataError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchCeremony()
      .then(async (current) => {
        if (cancelled) return;
        applyCeremony(current);
        // A card-less approval is the enrollment fallback, not the hot path.
        // It still needs OAuth because creating and binding a card mutates the vault.
        if (current.card_ref === null) await apiGet("/v1/vault/e2e");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          redirectToLogin();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load payment approval.");
      });
    return () => {
      cancelled = true;
    };
  }, [applyCeremony, fetchCeremony, redirectToLogin]);

  const refreshCeremony = useCallback(async (): Promise<void> => {
    setCardMetadataError(null);
    try {
      applyCeremony(await fetchCeremony());
    } catch (err) {
      setCardMetadataError(
        err instanceof Error ? err.message : "Failed to load the saved card details.",
      );
    }
  }, [applyCeremony, fetchCeremony]);

  const bindCard = useCallback(
    async (cardId: string) => {
      setSavedCardId(cardId);
      setBinding(true);
      setError(null);
      try {
        let bindFailure: unknown;
        try {
          const result = await apiPost<{ card_ref: string }>(
            `/v1/pay/approvals/${encodeURIComponent(id)}/bind-card`,
            { card_ref: cardId },
          );
          if (result.card_ref !== cardId) {
            throw new Error("The payment was attached to an unexpected card.");
          }
          setCeremony((current) =>
            current === null ? current : { ...current, card_ref: result.card_ref, card: null },
          );
          await refreshCeremony();
          return;
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            redirectToLogin();
            return;
          }
          bindFailure = err;
        }

        try {
          const current = await fetchCeremony();
          applyCeremony(current);
          if (current.card_ref === cardId) return;
          if (current.card_ref !== null) return;
        } catch {
          // Surface the original bind failure below; it is the actionable error.
        }
        setError(bindFailure instanceof Error ? bindFailure.message : "Failed to attach the card.");
      } finally {
        setBinding(false);
      }
    },
    [applyCeremony, fetchCeremony, id, redirectToLogin, refreshCeremony],
  );

  const prepareApproval = useCallback(async () => {
    if (
      ceremony === null ||
      ceremony.status !== "pending" ||
      ceremony.card_ref === null ||
      ceremony.approval_payload_sha256 === null ||
      ceremony.card === null
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    let key: Uint8Array | undefined;
    let card: Record<string, unknown> | undefined;
    let cardBytes: Uint8Array | undefined;
    try {
      const pairing = await getPairingState();
      if (!pairing.enrolled) {
        setNeedsPasskeySetup(true);
        return;
      }
      const publicKeyHash = await crypto.subtle.digest(
        "SHA-256",
        fromBase64Url(ceremony.operator_pubkey),
      );
      const recipientPubkeyHash = toBase64Url(new Uint8Array(publicKeyHash));
      const storedCard = JSON.parse(ceremony.card.blob) as StoredCard;
      // The only payment-context ceremony: it follows rendered server details
      // and binds exactly those canonical values.
      const payload = {
        approval_id: ceremony.id,
        merchant: ceremony.merchant,
        checkout_origin: ceremony.checkout_origin,
        amount_cents: ceremony.amount_cents,
        currency: ceremony.currency,
        nonce: ceremony.nonce,
        card_ref: ceremony.card_ref,
        recipient_pubkey_hash: recipientPubkeyHash,
        item: ceremony.item,
        reason: ceremony.reason,
        agent: ceremony.agent,
      };
      const sign = await getVouchflow().signPayload({
        context: "purchase",
        payload,
        minConfidence: "low",
        prfSalt: fromBase64(storedCard.prf_salt),
      });
      key = sign.prfResult;
      if (key === undefined) throw new Error("Passkey did not return a PRF result");
      card = await decryptCard(key, storedCard);
      cardBytes = new TextEncoder().encode(JSON.stringify(card));
      const aad = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sign.payload)),
      );
      const sealedCard = await sealToRecipient(ceremony.operator_pubkey, cardBytes, aad);
      await apiPost(`/v1/pay/approvals/${encodeURIComponent(id)}/approve`, {
        jws: sign.assertion,
        sealed_card: sealedCard,
      });
      setSubmitted(true);
      setNeedsPasskeySetup(false);
    } catch (err) {
      if (isPaymentPasskeyUnavailable(err)) {
        setNeedsPasskeySetup(true);
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to unlock payment approval.");
    } finally {
      key?.fill(0);
      cardBytes?.fill(0);
      card = undefined;
      setBusy(false);
    }
  }, [ceremony, id]);

  const setUpPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await apiGet("/v1/vault/e2e");
      await pairDevice();
      setNeedsPasskeySetup(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to set up a payment passkey.");
    } finally {
      setBusy(false);
    }
  }, [redirectToLogin]);

  const currentStatus = approval?.status ?? ceremony?.status;
  const terminalMessage =
    currentStatus === "approved"
      ? "Approved — you can return to your session."
      : currentStatus === "expired"
        ? "This payment approval has expired."
        : "This payment is no longer pending.";
  const isJitOrigin = jitOrigin === true;
  const jitBindingMismatch =
    isJitOrigin &&
    ceremony !== null &&
    ceremony.card_ref !== null &&
    (savedCardId === null || ceremony.card_ref !== savedCardId);
  const jitReviewBlocked =
    isJitOrigin && (jitBindingMismatch || ceremony?.card === null || cardMetadataError !== null);
  const needsCard = ceremony?.status === "pending" && ceremony.card_ref === null;
  const amountLabel =
    approval !== null ? formatAmount(approval.amount_cents, approval.currency) : "";
  const cardLine =
    approval?.card?.last4 != null
      ? `${approval.card.brand !== null ? `${approval.card.brand} ` : ""}··${approval.card.last4}`
      : "your saved card";

  return (
    <AppShell anonymous>
      <div className="app-head">
        <div>
          <h1 className="app-title">{needsCard ? "Add a card to pay" : "Approve payment"}</h1>
          <p className="app-sub">
            {needsCard
              ? "Sign in to add a payment card, then confirm with your passkey."
              : "Use your passkey to privately review this payment request."}
          </p>
        </div>
      </div>

      {error !== null && <div className="app-banner err">{error}</div>}
      {ceremony === null && error === null && <p className="app-sub">Loading…</p>}
      {submitted && <div className="app-banner ok">Approval sent — operator verifying.</div>}
      {ceremony !== null && currentStatus !== "pending" && (
        <div className={`app-banner ${currentStatus === "approved" ? "ok" : ""}`}>
          {terminalMessage}
        </div>
      )}

      {!submitted && needsCard && (
        <section aria-labelledby="add-card-heading">
          <h2 className="sect-label" id="add-card-heading">
            Card
          </h2>
          {binding ? (
            <p className="app-sub">Attaching card…</p>
          ) : savedCardId !== null ? (
            <div>
              <p className="app-sub">Your card is saved, but it still needs to be attached.</p>
              <button
                className="btn-primary"
                type="button"
                onClick={() => void bindCard(savedCardId)}
              >
                Retry attaching card
              </button>
            </div>
          ) : (
            <CardEntry onSaved={({ id: cardId }) => void bindCard(cardId)} />
          )}
        </section>
      )}

      {!submitted && approval?.status === "pending" && (
        <section className="app-card" aria-labelledby="payment-merchant">
          <h2 className="app-title" id="payment-merchant" style={{ fontSize: "18px" }}>
            {approval.merchant}
          </h2>
          <p className="app-sub" style={{ marginTop: "12px" }}>
            Paying at{" "}
            <span className="mono" style={{ overflowWrap: "anywhere" }}>
              {approval.checkout_origin}
            </span>
          </p>
          <dl className="app-sub" style={{ margin: "16px 0 0" }}>
            {[
              ["Item", approval.item || "—"],
              ["Requested by", approval.agent],
              ["Reason", approval.reason || "—"],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  display: "grid",
                  gridTemplateColumns: "max-content minmax(0, 1fr)",
                  gap: "8px",
                  marginTop: "8px",
                }}
              >
                <dt>{label}</dt>
                <dd className="mono" style={{ margin: 0, overflowWrap: "anywhere" }}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="pay-anchor">
            Pay with <span className="mono">{cardLine}</span> · {amountLabel} to {approval.merchant}
          </p>
          {jitReviewBlocked ? (
            <div className="app-banner err">
              {jitBindingMismatch
                ? "This payment was attached to a different card than the one you added."
                : (cardMetadataError ?? "We couldn't load the saved card for this payment.")}
              {!jitBindingMismatch && (
                <button className="linkbtn" type="button" onClick={() => void refreshCeremony()}>
                  Retry
                </button>
              )}
            </div>
          ) : needsPasskeySetup ? (
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
              onClick={() => void prepareApproval()}
              disabled={busy}
            >
              {busy ? "Approving…" : "Approve payment"}
            </button>
          )}
        </section>
      )}
    </AppShell>
  );
}
