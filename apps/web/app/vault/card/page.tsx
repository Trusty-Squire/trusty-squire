"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { encryptCard, type E2EBlob } from "@trusty-squire/vault/e2e";
import { AppShell } from "../../components/AppShell";
import { ApiError, apiGet, apiPost } from "../../lib/api";

interface SavedCard {
  id: string;
  label: string;
  createdAt: string;
}

export default function CardPage() {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [pan, setPan] = useState("");
  const [expMonth, setExpMonth] = useState("");
  const [expYear, setExpYear] = useState("");
  const [name, setName] = useState("");
  const [zip, setZip] = useState("");
  const [cvv, setCvv] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [cards, setCards] = useState<SavedCard[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setCards(await apiGet<SavedCard[]>("/v1/vault/e2e"));
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

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const card = {
          pan,
          exp_month: expMonth,
          exp_year: expYear,
          name,
          zip,
          ...(cvv === "" ? {} : { cvv }),
        };
        const blob: E2EBlob = await encryptCard(passphrase, card);
        await apiPost("/v1/vault/e2e", { label, blob: JSON.stringify(blob) });
        setLabel("");
        setPan("");
        setExpMonth("");
        setExpYear("");
        setName("");
        setZip("");
        setCvv("");
        setPassphrase("");
        await load();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login?next=/vault/card");
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to save card.");
      } finally {
        setBusy(false);
      }
    },
    [cvv, expMonth, expYear, label, load, name, pan, passphrase, router, zip],
  );

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Add card</h1>
          <p className="app-sub">
            Encrypted in this browser. The server cannot decrypt it.
          </p>
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
          <label htmlFor="card-exp-month">Expiration month</label>
          <input
            id="card-exp-month"
            className="mono"
            value={expMonth}
            onChange={(event) => setExpMonth(event.target.value)}
            inputMode="numeric"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="card-exp-year">Expiration year</label>
          <input
            id="card-exp-year"
            className="mono"
            value={expYear}
            onChange={(event) => setExpYear(event.target.value)}
            inputMode="numeric"
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
          <label htmlFor="card-zip">ZIP code</label>
          <input
            id="card-zip"
            className="mono"
            value={zip}
            onChange={(event) => setZip(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="card-cvv">CVV (optional)</label>
          <input
            id="card-cvv"
            className="mono"
            value={cvv}
            onChange={(event) => setCvv(event.target.value)}
            inputMode="numeric"
          />
        </div>
        <div className="field">
          <label htmlFor="card-passphrase">Passphrase</label>
          <input
            id="card-passphrase"
            className="mono"
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            required
          />
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
