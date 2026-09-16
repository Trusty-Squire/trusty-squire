"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { decryptCard, encryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { AppShell } from "../../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../../lib/api";
import { getPairingState, pairDevice } from "../../../lib/pairing";
import { evaluatePrf } from "../../../lib/passkey";
import { getVouchflow } from "../../../lib/vouchflow";
import { CARD_TRUST_COPY, cardLast4, detectCardBrand } from "../../../lib/wallet";

// edit_payment_card's human half. The ceremony endpoint hands this page the
// card's sealed blob; the card is decrypted HERE (passkey PRF), edited HERE,
// and re-encrypted HERE with the same key before anything is submitted. The
// server receives only the new opaque blob plus display metadata — the card
// values never leave this browser unencrypted, and the agent never sees them.

// The stored blob shape (CardEntry writes it): the E2E ciphertext plus the
// PRF salt the passkey ceremony needs to re-derive the decryption key.
interface StoredCard extends E2EBlob {
  prf_salt: string;
}

interface CardMetadata {
  label: string;
  brand: string | null;
  last4: string | null;
}

interface CardMutationCeremony {
  approval_id: string;
  status: "pending" | "approved" | "failed" | "expired";
  operation: "edit_card";
  card: { id: string; label: string; brand: string | null; last4: string | null };
  before: CardMetadata;
  after: CardMetadata | null;
  expires_at: string;
  error?: string;
  blob: string;
  payload: unknown;
  payload_sha256: string;
}

// What the decrypted blob contains. The CVV is prefilled into the edit form
// so a re-encrypt keeps it valid, but it is never shown as plain text beyond
// the field itself (same boundary as CardDetails).
interface DecryptedCard {
  pan: string;
  exp_month: string;
  exp_year: string;
  name: string;
  cvv: string;
  billing: Record<string, string>;
}

// Mobile numeric keypads have no `/` key (inputMode="numeric"), so the
// Expiration field must build MM/YY from digits alone (same as CardEntry).
function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function billingObject(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

export default function CardMutationApprovalPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [ceremony, setCeremony] = useState<CardMutationCeremony | null>(null);
  const [decrypted, setDecrypted] = useState<DecryptedCard | null>(null);
  const [busy, setBusy] = useState(false);
  const [needsPasskeySetup, setNeedsPasskeySetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Edit-form state. Prefilled from the decrypted card.
  const [label, setLabel] = useState("");
  const [pan, setPan] = useState("");
  const [expiry, setExpiry] = useState("");
  const [name, setName] = useState("");
  const [cvv, setCvv] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");

  const redirectToLogin = useCallback(() => {
    router.replace(`/login?next=/vault/mutate-card/${encodeURIComponent(id)}`);
  }, [id, router]);

  const fetchCeremony = useCallback(
    () =>
      apiGet<CardMutationCeremony>(
        `/v1/vault/card-mutation-approvals/${encodeURIComponent(id)}/ceremony`,
      ),
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

  // Decrypt into the edit form. This is the same passkey PRF ceremony the
  // wallet's reveal uses — the only way the PAN can exist outside the blob.
  const startEditing = useCallback(async () => {
    if (ceremony === null || ceremony.status !== "pending") return;
    setBusy(true);
    setError(null);
    try {
      const pairing = await getPairingState();
      if (!pairing.enrolled) {
        setNeedsPasskeySetup(true);
        return;
      }
      const stored = JSON.parse(ceremony.blob) as StoredCard;
      const salt = atob(stored.prf_salt);
      const saltBytes = new Uint8Array(salt.length);
      for (let index = 0; index < salt.length; index += 1) {
        saltBytes[index] = salt.charCodeAt(index);
      }
      let key: Uint8Array;
      try {
        key = await evaluatePrf(saltBytes);
      } catch {
        throw new Error("This device can't use passkeys, or the request was cancelled.");
      }
      try {
        const card = await decryptCard(key, stored);
        setDecrypted({
          pan: asString(card.pan),
          exp_month: asString(card.exp_month),
          exp_year: asString(card.exp_year),
          name: asString(card.name),
          cvv: asString(card.cvv),
          billing: billingObject(card.billing),
        });
        setLabel(ceremony.card.label);
        setPan(asString(card.pan));
        setExpiry(
          asString(card.exp_month) !== ""
            ? `${asString(card.exp_month)}/${asString(card.exp_year)}`
            : "",
        );
        setName(asString(card.name));
        setCvv(asString(card.cvv));
        const billing = billingObject(card.billing);
        setLine1(asString(billing.line1));
        setLine2(asString(billing.line2));
        setCity(asString(billing.city));
        setState(asString(billing.state));
        setPostalCode(asString(billing.postal_code));
        setCountry(asString(billing.country));
      } finally {
        key.fill(0);
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Couldn't open this card for editing.");
    } finally {
      setBusy(false);
    }
  }, [ceremony, redirectToLogin]);

  const setUpPasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await pairDevice();
      setNeedsPasskeySetup(false);
      await startEditing();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        redirectToLogin();
        return;
      }
      setError(caught instanceof Error ? caught.message : "Failed to set up passkey.");
    } finally {
      setBusy(false);
    }
  }, [redirectToLogin, startEditing]);

  // Re-encrypt with the SAME key the card was opened with, then sign the
  // ceremony payload with the edited card swapped in as `mutation.after`.
  const saveEdits = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (ceremony === null || decrypted === null || ceremony.status !== "pending") return;
      setBusy(true);
      setError(null);
      try {
        const expiryMatch = expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
        if (expiryMatch === null) {
          throw new Error("Expiration must use MM/YY.");
        }
        const expMonth = expiryMatch[1]!;
        const expYear = expiryMatch[2]!;
        const month = Number(expMonth);
        const fullYear = 2000 + Number(expYear);
        const now = new Date();
        if (
          month < 1 ||
          month > 12 ||
          fullYear < now.getFullYear() ||
          (fullYear === now.getFullYear() && month < now.getMonth() + 1)
        ) {
          throw new Error("Expiration must be a valid future month.");
        }
        const card = {
          pan,
          exp_month: expMonth,
          exp_year: expYear,
          name,
          cvv,
          billing: { line1, line2, city, state, postal_code: postalCode, country },
        };
        const stored = JSON.parse(ceremony.blob) as StoredCard;
        const salt = atob(stored.prf_salt);
        const saltBytes = new Uint8Array(salt.length);
        for (let index = 0; index < salt.length; index += 1) {
          saltBytes[index] = salt.charCodeAt(index);
        }
        let key: Uint8Array;
        try {
          key = await evaluatePrf(saltBytes);
        } catch {
          throw new Error("This device can't use passkeys, or the request was cancelled.");
        }
        try {
          const encrypted = await encryptCard(key, card);
          const blob = JSON.stringify({ ...encrypted, prf_salt: stored.prf_salt });
          // Display-only metadata derived from the PAN in this browser —
          // outside the sealed blob the server sees brand + last4 only.
          const brand = detectCardBrand(pan);
          const last4 = cardLast4(pan);
          const base = ceremony.payload as {
            mutation?: Record<string, unknown>;
          };
          const payload = {
            ...base,
            mutation: {
              ...base.mutation,
              // The server re-derives `after` with brand/last4 ALWAYS
              // present (null when undetectable), so sign exactly that.
              after: { label, blob, brand, last4 },
            },
          };
          const signed = await getVouchflow().signPayload({
            context: "vault_credential_mutation",
            payload,
            minConfidence: "low",
          });
          await apiPost(
            `/v1/vault/card-mutation-approvals/${encodeURIComponent(ceremony.approval_id)}/approve`,
            {
              jws: signed.assertion,
              blob,
              label,
              ...(brand !== null ? { brand } : {}),
              ...(last4 !== null ? { last4 } : {}),
            },
          );
          setCeremony(await fetchCeremony());
          setDecrypted(null);
          setNeedsPasskeySetup(false);
        } finally {
          key.fill(0);
        }
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 401) {
          redirectToLogin();
          return;
        }
        setError(caught instanceof Error ? caught.message : "Approval failed.");
      } finally {
        setBusy(false);
      }
    },
    [ceremony, city, country, cvv, decrypted, expiry, fetchCeremony, label, line1, line2, name, pan, postalCode, redirectToLogin, state],
  );

  const mask = ceremony?.card.last4 !== null && ceremony?.card.last4 !== undefined && ceremony?.card.last4 !== ""
    ? `•••• •••• •••• ${ceremony.card.last4}`
    : "•••• •••• •••• ••••";
  const terminal =
    ceremony?.status === "approved"
      ? "Approved — the card is updated. You can return to your agent session."
      : ceremony?.status === "expired"
        ? "This card edit approval has expired."
        : ceremony?.status === "failed"
          ? `The vault refused this edit${ceremony.error ? `: ${ceremony.error}` : "."}`
          : null;

  return (
    <AppShell anonymous>
      <div className="app-head">
        <div>
          <h1 className="app-title">Edit saved card</h1>
          <p className="app-sub">
            The card opens here in your browser, decrypted with your passkey. Edit the fields and
            confirm — your card details are re-encrypted locally and our servers never see them.
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
        <section className="app-card" aria-labelledby="card-target">
          <h2 className="app-title" id="card-target" style={{ fontSize: "var(--t-lg)" }}>
            {ceremony.card.label}
          </h2>
          <p className="mono app-sub" style={{ marginTop: "var(--s-3)" }}>
            {mask}
            {ceremony.card.brand !== null ? ` · ${ceremony.card.brand}` : ""}
          </p>

          {ceremony.status === "pending" && decrypted === null && (
            <div style={{ marginTop: "var(--s-6)" }}>
              {needsPasskeySetup ? (
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
                  onClick={() => void startEditing()}
                  disabled={busy}
                >
                  {busy ? "Opening…" : "Edit card details"}
                </button>
              )}
            </div>
          )}

          {ceremony.status === "pending" && decrypted !== null && (
            <form className="form cred-form" onSubmit={saveEdits} autoComplete="off">
              <div className="field">
                <label htmlFor="card-label">Label</label>
                <input
                  id="card-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="card-pan">Card number</label>
                <input
                  id="card-pan"
                  className="mono"
                  value={pan}
                  onChange={(event) => setPan(event.target.value)}
                  inputMode="numeric"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="card-expiry">Expiration</label>
                <input
                  id="card-expiry"
                  className="mono"
                  value={expiry}
                  onChange={(event) => setExpiry(formatExpiry(event.target.value))}
                  inputMode="numeric"
                  placeholder="MM/YY"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="card-name">Name on card</label>
                <input
                  id="card-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="card-cvv">CVV</label>
                <input
                  id="card-cvv"
                  className="mono"
                  value={cvv}
                  onChange={(event) => setCvv(event.target.value)}
                  inputMode="numeric"
                  required
                />
              </div>

              <h2 className="dz-head">Billing address</h2>

              <div className="field">
                <label htmlFor="billing-line1">Address line 1</label>
                <input
                  id="billing-line1"
                  value={line1}
                  onChange={(event) => setLine1(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="billing-line2">Address line 2 (optional)</label>
                <input
                  id="billing-line2"
                  value={line2}
                  onChange={(event) => setLine2(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="billing-city">City</label>
                <input
                  id="billing-city"
                  value={city}
                  onChange={(event) => setCity(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="billing-state">State / Province / Region</label>
                <input
                  id="billing-state"
                  value={state}
                  onChange={(event) => setState(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="billing-postal-code">Postal code</label>
                <input
                  id="billing-postal-code"
                  className="mono"
                  value={postalCode}
                  onChange={(event) => setPostalCode(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="billing-country">Country</label>
                <input
                  id="billing-country"
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                  required
                />
              </div>

              <p className="trust-copy">{CARD_TRUST_COPY}</p>

              <div className="form-actions">
                <button className="btn-primary" type="submit" disabled={busy}>
                  {busy ? "Approving…" : "Save and confirm"}
                </button>
              </div>
            </form>
          )}
        </section>
      )}
    </AppShell>
  );
}
