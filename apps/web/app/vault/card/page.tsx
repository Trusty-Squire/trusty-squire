"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { encryptCard } from "@trusty-squire/vault/e2e";
import { AppShell } from "../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../lib/api";
import { COUNTRIES } from "../../lib/countries";
import { getPairingState, pairDevice } from "../../lib/pairing";
import { evaluatePrf } from "../../lib/passkey";

interface SavedCard {
  id: string;
  label: string;
  createdAt: string;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export default function CardPage() {
  const router = useRouter();
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
  const [cards, setCards] = useState<SavedCard[] | null>(null);
  const [enrolled, setEnrolled] = useState<boolean | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setCards(await apiGet<SavedCard[]>("/v1/vault/e2e"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getPairingState()
      .then((state) => {
        if (!cancelled) setEnrolled(state.enrolled);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEnrolled(false);
        setPairingError(err instanceof Error ? err.message : "Failed to check passkey setup.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().catch((err: unknown) => {
      if (cancelled) return;
      if (err instanceof ApiError && err.status === 401) {
        router.replace("/login?next=/vault/card");
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load saved cards.");
    });
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  const pair = useCallback(async (): Promise<void> => {
    setPairing(true);
    setPairingError(null);
    try {
      await pairDevice();
      const state = await getPairingState();
      setEnrolled(state.enrolled);
      if (!state.enrolled) {
        throw new Error("Passkey setup did not complete. Please try again.");
      }
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : "Failed to set up payments.");
    } finally {
      setPairing(false);
    }
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      let key: Uint8Array | undefined;
      try {
        const expiryMatch = expiry.match(/^(\d{2})\s*\/\s*(\d{2})$/);
        if (expiryMatch === null) {
          throw new Error("Expiration must use MM / YY.");
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
        const prfSalt = crypto.getRandomValues(new Uint8Array(32));
        try {
          key = await evaluatePrf(prfSalt);
        } catch {
          throw new Error("This device can't use passkeys, or the request was cancelled.");
        }
        const blob = await encryptCard(key, card);
        await apiPost("/v1/vault/e2e", {
          label,
          blob: JSON.stringify({ ...blob, prf_salt: toBase64(prfSalt) }),
        });
        setLabel("");
        setPan("");
        setExpiry("");
        setName("");
        setCvv("");
        setLine1("");
        setLine2("");
        setCity("");
        setState("");
        setPostalCode("");
        setCountry("");
        await load();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/card");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to save card.");
      } finally {
        key?.fill(0);
        setBusy(false);
      }
    },
    [city, country, cvv, expiry, label, line1, line2, load, name, pan, postalCode, router, state],
  );

  if (enrolled !== true) {
    return (
      <AppShell>
        <div className="app-head">
          <div>
            <h1 className="app-title">Add card</h1>
            <p className="app-sub">Encrypted in this browser. The server cannot decrypt it.</p>
          </div>
        </div>

        {enrolled === null ? (
          <div className="app-card" aria-live="polite">
            Checking…
          </div>
        ) : (
          <div className="app-card">
            <h2>Set up payments on this device</h2>
            <p className="app-sub">
              A one-time Face ID / Touch ID setup lets this device encrypt and approve card
              payments. Your card is never readable by our servers.
            </p>
            {pairingError !== null && <div className="form-err">{pairingError}</div>}
            <button
              className="btn-primary"
              type="button"
              disabled={pairing}
              onClick={() => void pair()}
            >
              {pairing ? "Setting up…" : "Set up"}
            </button>
          </div>
        )}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Add card</h1>
          <p className="app-sub">Encrypted in this browser. The server cannot decrypt it.</p>
        </div>
      </div>

      <form className="form cred-form" onSubmit={submit} autoComplete="off">
        <div className="field">
          <label htmlFor="card-label">Label</label>
          <input
            id="card-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Personal card"
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
            onChange={(event) => setExpiry(event.target.value)}
            inputMode="numeric"
            placeholder="MM / YY"
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
          <select
            id="billing-country"
            value={country}
            onChange={(event) => setCountry(event.target.value)}
            required
          >
            <option value="" disabled>
              Select country
            </option>
            {COUNTRIES.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </div>

        {error !== null && <div className="form-err">{error}</div>}

        <div className="form-actions">
          <button className="btn-primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>

      <section className="danger-zone" aria-labelledby="saved-cards-title">
        <h2 className="dz-head" id="saved-cards-title">
          Saved cards
        </h2>
        {cards === null && error === null && (
          <div className="dz-row">
            <div className="dz-sub">Loading…</div>
          </div>
        )}
        {cards !== null && cards.length === 0 && (
          <div className="dz-row">
            <div className="dz-sub">No saved cards.</div>
          </div>
        )}
        {cards?.map((card) => (
          <div className="dz-row" key={card.id}>
            <div className="dz-title">{card.label}</div>
            <div className="row-meta">{card.createdAt}</div>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
