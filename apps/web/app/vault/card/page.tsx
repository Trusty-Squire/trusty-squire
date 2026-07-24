"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "../../components/AppShell";
import { CardEntry } from "../../components/CardEntry";
import { ApiError, apiGet } from "../../lib/api";

interface SavedCard {
  id: string;
  label: string;
  createdAt: string;
}

export default function CardPage() {
  const router = useRouter();
  const [cards, setCards] = useState<SavedCard[] | null>(null);
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

  return (
    <AppShell>
      <div className="app-head">
        <div>
          <h1 className="app-title">Add card</h1>
          <p className="app-sub">Encrypted in this browser. The server cannot decrypt it.</p>
        </div>
      </div>

      <CardEntry onSaved={() => void load()} />

      <section className="danger-zone" aria-labelledby="saved-cards-title">
        <h2 className="dz-head" id="saved-cards-title">
          Saved cards
        </h2>
        {error !== null && <div className="form-err">{error}</div>}
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
