"use client";

import { useCallback, useState } from "react";
import { decryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { apiGet } from "../lib/api";
import { evaluatePrf } from "../lib/passkey";
import { type CardMeta } from "../lib/wallet";

// The stored blob shape (CardEntry writes it): the E2E ciphertext plus the
// PRF salt the passkey ceremony needs to re-derive the decryption key.
interface StoredCard extends E2EBlob {
  prf_salt: string;
}

// What the detail view shows after the passkey ceremony. THE CVV IS NEVER
// HERE: it exists only inside the sealed blob (the server can't read it and
// never returns it as a field), and this view drops it at decrypt time —
// no masked-with-reveal, simply never rendered, owner included.
interface RevealedCard {
  pan: string;
  name: string;
  expiry: string;
  billing: string;
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// "4242424242424242" → "4242 4242 4242 4242" for the revealed line.
function groupPan(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  return (digits.match(/.{1,4}/g) ?? [digits]).join(" ");
}

function billingLine(billing: unknown): string {
  if (typeof billing !== "object" || billing === null) return "";
  const b = billing as Record<string, unknown>;
  return ["line1", "line2", "city", "state", "postal_code", "country"]
    .map((key) => asString(b[key]).trim())
    .filter((part) => part.length > 0)
    .join(", ");
}

// The expanded particulars of a wallet row. Metadata (brand/label/last4/
// added) is already on the row; this shows the sealed details behind the
// vault's reveal convention — masked by default, an explicit `reveal`
// control — where reveal IS the passkey ceremony (the only way the PAN
// can exist outside the blob: it never left this browser unencrypted).
export function CardDetails({ card }: { card: CardMeta }) {
  const [revealed, setRevealed] = useState<RevealedCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reveal = useCallback(async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    setBusy(true);
    setError(null);
    let key: Uint8Array | undefined;
    try {
      const { blob } = await apiGet<{ blob: string }>(`/v1/vault/e2e/${card.id}`);
      const stored = JSON.parse(blob) as StoredCard;
      try {
        key = await evaluatePrf(fromBase64(stored.prf_salt));
      } catch {
        throw new Error("This device can't use passkeys, or the request was cancelled.");
      }
      const decrypted = await decryptCard(key, stored);
      // Deliberate: cvv is discarded here and never enters component state
      // or the DOM. Everything else is shown.
      setRevealed({
        pan: groupPan(asString(decrypted.pan)),
        name: asString(decrypted.name),
        expiry:
          asString(decrypted.exp_month) !== ""
            ? `${asString(decrypted.exp_month)} / ${asString(decrypted.exp_year)}`
            : "",
        billing: billingLine(decrypted.billing),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't reveal this card.");
    } finally {
      key?.fill(0);
      setBusy(false);
    }
  }, [card.id, revealed]);

  const mask = card.last4 !== null ? `•••• •••• •••• ${card.last4}` : "•••• •••• •••• ••••";
  const added = new Date(card.createdAt).toLocaleDateString();

  return (
    <div className="card-details">
      <div className="meta">
        <span>added {added}</span>
      </div>
      <div className="secret">
        {revealed !== null ? (
          <span className="vals">
            <span className="val-line">
              <span className="field-name">number</span>
              <span className="val">{revealed.pan}</span>
            </span>
            {revealed.name !== "" && (
              <span className="val-line">
                <span className="field-name">name</span>
                <span className="val">{revealed.name}</span>
              </span>
            )}
            {revealed.expiry !== "" && (
              <span className="val-line">
                <span className="field-name">expires</span>
                <span className="val">{revealed.expiry}</span>
              </span>
            )}
            {revealed.billing !== "" && (
              <span className="val-line">
                <span className="field-name">billing</span>
                <span className="val">{revealed.billing}</span>
              </span>
            )}
            {/* No CVV line, ever — see RevealedCard. */}
          </span>
        ) : (
          <span className="mask">{busy ? "revealing…" : mask}</span>
        )}
        <button type="button" className="linkbtn" onClick={() => void reveal()} disabled={busy}>
          {revealed !== null ? "hide" : "reveal"}
        </button>
      </div>
      {error !== null && <div className="form-err">{error}</div>}
    </div>
  );
}
