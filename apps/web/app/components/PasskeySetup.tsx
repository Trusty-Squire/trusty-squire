"use client";

import { useState } from "react";
import { apiGet } from "../lib/api";
import { errorText } from "../lib/error-text";
import { isPasskeyRecoveryRequired } from "../lib/pairing";
import type { CardMeta } from "../lib/wallet";

interface PasskeySetupProps {
  onSetup: (forceNew: boolean) => Promise<void>;
  busy?: boolean;
  label?: string;
  cardName?: string;
}

// Shared by every setup entry point. Recovery is always tried first. A fresh
// credential is possible only after an explicit choice and warning.
export function PasskeySetup({
  onSetup,
  busy = false,
  label = "Sign in and set up passkey",
  cardName,
}: PasskeySetupProps) {
  const [working, setWorking] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || working;

  const setup = async (forceNew: boolean) => {
    if (disabled) return;
    setWorking(true);
    setError(null);
    try {
      if (forceNew) {
        const savedCards = await apiGet<CardMeta[]>("/v1/vault/e2e")
          .then((cards) => cards.map((card) => card.label))
          .catch(() => [] as string[]);
        const cards = [
          ...new Set([cardName, ...savedCards].filter((name): name is string => Boolean(name))),
        ];
        const affected =
          cards.length > 0
            ? ` Affected saved ${cards.length === 1 ? "card" : "cards"}: ${cards.join(", ")}.`
            : " Any cards saved with the old passkey may stay locked here.";
        if (
          !window.confirm(
            `Create a new passkey? A new passkey cannot unlock cards saved with the old one.${affected}`,
          )
        ) return;
      }
      await onSetup(forceNew);
      setRecoveryRequired(false);
    } catch (caught) {
      if (isPasskeyRecoveryRequired(caught)) {
        setRecoveryRequired(true);
        setError("We couldn't recover your existing passkey. Choose how to continue.");
      } else {
        setError(errorText(caught, "Failed to set up passkey."));
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <div>
      {error !== null && <div className="form-err">{error}</div>}
      {recoveryRequired ? (
        <div style={{ display: "flex", gap: "var(--s-3)", flexWrap: "wrap" }}>
          <button className="btn-primary" type="button" disabled={disabled} onClick={() => void setup(false)}>
            {disabled ? "Recovering…" : "Use your existing passkey"}
          </button>
          <button className="btn-secondary" type="button" disabled={disabled} onClick={() => void setup(true)}>
            Create a new passkey
          </button>
        </div>
      ) : (
        <button className="btn-primary" type="button" disabled={disabled} onClick={() => void setup(false)}>
          {disabled ? "Setting up…" : label}
        </button>
      )}
    </div>
  );
}
