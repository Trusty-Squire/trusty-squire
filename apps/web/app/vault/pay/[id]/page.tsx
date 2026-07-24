"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { decryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { sealToRecipient } from "@trusty-squire/vault/hpke";
import { AppShell } from "../../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { evaluatePrf } from "../../../lib/passkey";
import { getVouchflow } from "../../../lib/vouchflow";

interface Approval {
  status: string;
  merchant: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  card_ref: string;
  operator_pubkey: string;
  expires_at: string;
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
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency}`;
  }
}

export default function PaymentApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [approval, setApproval] = useState<Approval | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/pay/${encodeURIComponent(id)}`);
  }, [id, router]);

  useEffect(() => {
    let cancelled = false;
    void apiGet<Approval>(`/v1/pay/approvals/${encodeURIComponent(id)}`)
      .then((result) => {
        if (!cancelled) setApproval(result);
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
  }, [id, redirectToLogin]);

  const approve = useCallback(async () => {
    if (approval === null || approval.status !== "pending") return;

    setBusy(true);
    setError(null);
    let key: Uint8Array | undefined;
    let card: Record<string, unknown> | undefined;
    let cardBytes: Uint8Array | undefined;

    try {
      const publicKeyHash = await crypto.subtle.digest(
        "SHA-256",
        fromBase64Url(approval.operator_pubkey),
      );
      const payload = {
        merchant: approval.merchant,
        amount_cents: approval.amount_cents,
        currency: approval.currency,
        nonce: approval.nonce,
        recipient_pubkey_hash: toBase64Url(new Uint8Array(publicKeyHash)),
      };
      const sign = await getVouchflow().signPayload({
        context: "purchase",
        payload,
        minConfidence: "high",
      });
      const aad = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sign.payload)),
      );
      const { blob } = await apiGet<{ blob: string }>(
        `/v1/vault/e2e/${encodeURIComponent(approval.card_ref)}`,
      );
      const storedCard = JSON.parse(blob) as StoredCard;
      key = await evaluatePrf(fromBase64(storedCard.prf_salt));
      card = await decryptCard(key, storedCard);
      cardBytes = new TextEncoder().encode(JSON.stringify(card));
      const sealedCard = await sealToRecipient(
        approval.operator_pubkey,
        cardBytes,
        aad,
      );

      await apiPost(`/v1/pay/approvals/${encodeURIComponent(id)}/approve`, {
        jws: sign.assertion,
        sealed_card: sealedCard,
      });
      setApproval({ ...approval, status: "approved" });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        redirectToLogin();
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to approve payment.");
    } finally {
      key?.fill(0);
      cardBytes?.fill(0);
      card = undefined;
      setBusy(false);
    }
  }, [approval, id, redirectToLogin]);

  const terminalMessage =
    approval?.status === "approved"
      ? "Approved — you can return to your session."
      : approval?.status === "expired"
        ? "This payment approval has expired."
        : "This payment is no longer pending.";

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Approve payment</h1>
          <p className="app-sub">Confirm the purchase with your passkey.</p>
        </div>
      </div>

      {error !== null && <div className="app-banner err">{error}</div>}

      {approval === null && error === null && <p className="app-sub">Loading…</p>}

      {approval !== null && approval.status !== "pending" && (
        <div className={`app-banner ${approval.status === "approved" ? "ok" : ""}`}>
          {terminalMessage}
        </div>
      )}

      {approval?.status === "pending" && (
        <section className="app-card" aria-labelledby="payment-merchant">
          <h2 className="app-title" id="payment-merchant" style={{ fontSize: "18px" }}>
            {approval.merchant}
          </h2>
          <p className="app-title mono" style={{ marginTop: "12px" }}>
            {formatAmount(approval.amount_cents, approval.currency)}
          </p>
          <button
            className="btn-primary"
            type="button"
            onClick={() => void approve()}
            disabled={busy}
          >
            {busy ? "Approving…" : "Approve payment"}
          </button>
        </section>
      )}
    </AppShell>
  );
}
