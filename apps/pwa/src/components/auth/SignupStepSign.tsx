"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { MandateReview } from "./MandateReview";
import { loadSignup } from "./signup-state";
import { signPayload, isVouchflowError } from "@/lib/vouchflow";
import { api, ApiClientError } from "@/lib/api-client";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function SignupStepSign() {
  const router = useRouter();
  const state = loadSignup();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expiresAt = new Date(Date.now() + ONE_YEAR_MS);

  if (state === null || !state.enrolled) {
    return (
      <p className="text-[color:var(--color-ink-soft)]">
        Your signup session has expired.{" "}
        <a href="/signup">Start again</a>.
      </p>
    );
  }

  async function onSign() {
    if (state === null) return;
    setPending(true);
    setError(null);
    try {
      const registerBundle = await signPayload({
        context: "account_register",
        payload: { email: state.email, display_name: state.display_name },
        userHandle: state.email,
        minConfidence: "medium",
      });
      await api.registerAccount(registerBundle);

      const mandateBundle = await signPayload({
        context: "mandate_signing",
        payload: {
          email: state.email,
          policy: state.policy,
          expires_at: expiresAt.toISOString(),
        },
        userHandle: state.email,
        minConfidence: "high",
      });
      await api.createMandate(mandateBundle);
      router.push("/signup/connect");
    } catch (err) {
      const msg = isVouchflowError(err)
        ? `Signature failed: ${err.code}`
        : err instanceof ApiClientError
          ? `Server rejected: ${err.status}`
          : "Something went wrong.";
      setError(msg);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <MandateReview policy={state.policy} expiresAt={expiresAt} />
      {error !== null ? (
        <p role="alert" className="text-[color:var(--color-wine)] text-sm">
          {error}
        </p>
      ) : null}
      <Button onClick={onSign} disabled={pending} className="w-full">
        {pending ? "Signing…" : "Sign with passkey"}
      </Button>
    </div>
  );
}
