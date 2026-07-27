"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { decryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { sealToRecipient } from "@trusty-squire/vault/hpke";
import { AppShell } from "../../../components/AppShell";
import { CardEntry } from "../../../components/CardEntry";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { getVouchflow } from "../../../lib/vouchflow";
import { boundCardMeta, type CardMeta } from "../../../lib/wallet";

interface Approval {
  status: string;
  merchant: string;
  checkout_origin: string;
  amount_cents: number;
  currency: string;
  nonce: string;
  // Null for a JIT add-card ceremony until a card is bound.
  card_ref: string | null;
  operator_pubkey: string;
  expires_at: string;
  item: string;
  reason: string;
  agent: string;
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
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    const minorDigits = formatter.resolvedOptions().maximumFractionDigits;
    if (minorDigits === undefined) {
      return `${amountCents} ${currency} minor units`;
    }
    return formatter.format(amountCents / 10 ** minorDigits);
  } catch {
    return `${amountCents} ${currency} minor units`;
  }
}

export default function PaymentApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [approval, setApproval] = useState<Approval | null>(null);
  // The account's cards — the ONLY honest source for the last4 shown before
  // the passkey ceremony. Keyed by the approval's server-bound card_ref, never
  // by local page state or a post-passkey blob decrypt.
  const [cards, setCards] = useState<readonly CardMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/pay/${encodeURIComponent(id)}`);
  }, [id, router]);

  // Fetch the approval + card list together. Pure fetch (no setState) so it
  // can back both the mount effect and the post-bind refresh without tripping
  // the set-state-in-effect rule. The card list is best-effort enrichment for
  // the review anchor — its failure must not block a has-card approval.
  const fetchState = useCallback(async (): Promise<{
    approval: Approval;
    cards: readonly CardMeta[];
  }> => {
    const [approval, cards] = await Promise.all([
      apiGet<Approval>(`/v1/pay/approvals/${encodeURIComponent(id)}`),
      apiGet<CardMeta[]>("/v1/vault/e2e").catch(() => [] as CardMeta[]),
    ]);
    return { approval, cards };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    void fetchState()
      .then((state) => {
        if (cancelled) return;
        setApproval(state.approval);
        setCards(state.cards);
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
  }, [fetchState, redirectToLogin]);

  // JIT add-card: the freshly stored card is bound to this card-less approval
  // server-side, then we reload so the review beat renders from the bound
  // card_ref. Approval stays pending — only card_ref transitions null → set.
  const bindCard = useCallback(
    async (cardId: string) => {
      setBinding(true);
      setError(null);
      try {
        await apiPost(`/v1/pay/approvals/${encodeURIComponent(id)}/bind-card`, {
          card_ref: cardId,
        });
        const state = await fetchState();
        setApproval(state.approval);
        setCards(state.cards);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          redirectToLogin();
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to attach the card.");
      } finally {
        setBinding(false);
      }
    },
    [id, fetchState, redirectToLogin],
  );

  const approve = useCallback(async () => {
    if (approval === null || approval.status !== "pending" || approval.card_ref === null) return;
    const cardRef = approval.card_ref;

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
        checkout_origin: approval.checkout_origin,
        amount_cents: approval.amount_cents,
        currency: approval.currency,
        nonce: approval.nonce,
        card_ref: cardRef,
        recipient_pubkey_hash: toBase64Url(new Uint8Array(publicKeyHash)),
        item: approval.item,
        reason: approval.reason,
        agent: approval.agent,
      };
      const { blob } = await apiGet<{ blob: string }>(
        `/v1/vault/e2e/${encodeURIComponent(cardRef)}`,
      );
      const storedCard = JSON.parse(blob) as StoredCard;
      const sign = await getVouchflow().signPayload({
        context: "purchase",
        payload,
        minConfidence: "low",
        prfSalt: fromBase64(storedCard.prf_salt),
      });
      key = sign.prfResult;
      if (key === undefined) {
        throw new Error("Passkey did not return a PRF result");
      }
      const aad = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sign.payload)),
      );
      card = await decryptCard(key, storedCard);
      cardBytes = new TextEncoder().encode(JSON.stringify(card));
      const sealedCard = await sealToRecipient(approval.operator_pubkey, cardBytes, aad);

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

  const boundCard = approval !== null ? boundCardMeta(approval.card_ref, cards) : null;
  const amountLabel =
    approval !== null ? formatAmount(approval.amount_cents, approval.currency) : "";
  // "Visa ··1234" when the bound card has stored metadata; a neutral fallback
  // for a legacy card without metadata (still the account's card, just no
  // display digits until re-added).
  const cardLine =
    boundCard?.last4 != null
      ? `${boundCard.brand !== null ? `${boundCard.brand} ` : ""}··${boundCard.last4}`
      : "your saved card";
  const needsCard = approval?.status === "pending" && approval.card_ref === null;

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">{needsCard ? "Add a card to pay" : "Approve payment"}</h1>
          <p className="app-sub">
            {needsCard
              ? "Add the card you want to pay with, then confirm the purchase."
              : "Confirm the purchase with your passkey."}
          </p>
        </div>
      </div>

      {error !== null && <div className="app-banner err">{error}</div>}

      {approval === null && error === null && <p className="app-sub">Loading…</p>}

      {approval !== null && approval.status !== "pending" && (
        <div className={`app-banner ${approval.status === "approved" ? "ok" : ""}`}>
          {terminalMessage}
        </div>
      )}

      {/* Beat 1 — add card. Only when the approval was minted card-less. The
          shared CardEntry stores the card, then we bind it and advance. */}
      {needsCard && (
        <section aria-labelledby="add-card-heading">
          <h2 className="sect-label" id="add-card-heading">
            Card
          </h2>
          <p className="app-sub" style={{ marginBottom: "16px" }}>
            Paying {amountLabel} to <span className="mono">{approval!.merchant}</span>.
          </p>
          {binding ? (
            <p className="app-sub">Attaching card…</p>
          ) : (
            <CardEntry onSaved={({ id: cardId }) => void bindCard(cardId)} />
          )}
        </section>
      )}

      {/* Beat 2 — review + approve. A distinct beat with the bound card's
          last4 as the visual anchor, so the card is impossible to tap past
          before the passkey. Approve is the lone action beneath it. */}
      {approval?.status === "pending" && approval.card_ref !== null && (
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
            Pay with <span className="mono">{cardLine}</span> · {amountLabel} to{" "}
            {approval.merchant}
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
