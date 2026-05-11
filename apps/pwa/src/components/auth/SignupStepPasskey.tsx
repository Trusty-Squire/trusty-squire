"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { enroll, isVouchflowError } from "@/lib/vouchflow";
import { loadSignup, saveSignup } from "./signup-state";

export function SignupStepPasskey() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enrollPasskey() {
    const state = loadSignup();
    if (state === null) {
      router.push("/signup");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await enroll(state.email);
      saveSignup({ ...state, enrolled: true });
      router.push("/signup/policy");
    } catch (err) {
      setError(
        isVouchflowError(err) ? `Passkey enrollment failed: ${err.code}` : "Passkey enrollment failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-[color:var(--color-ink-soft)]">
        Your passkey is what authorizes your squire. Stored on this device, never on our servers.
      </p>
      {error !== null ? (
        <p role="alert" className="text-[color:var(--color-wine)] text-sm">
          {error}
        </p>
      ) : null}
      <Button onClick={enrollPasskey} disabled={pending} className="w-full">
        {pending ? "Enrolling…" : "Set up passkey"}
      </Button>
    </div>
  );
}
