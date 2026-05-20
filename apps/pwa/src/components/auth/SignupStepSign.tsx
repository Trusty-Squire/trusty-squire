"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { MandateReview } from "./MandateReview";
import { loadSignup } from "./signup-state";
import { signPayload, isVouchflowError } from "@/lib/vouchflow";
import { api, ApiClientError } from "@/lib/api-client";
import { VouchflowDiagnostics } from "./VouchflowDiagnostics";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function SignupStepSign() {
  const router = useRouter();
  const state = loadSignup();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorObj, setErrorObj] = useState<unknown>(null);
  const expiresAt = new Date(Date.now() + ONE_YEAR_MS);

  if (state === null) {
    return (
      <p className="text-[color:var(--color-text-soft)]">
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
      // Single ceremony — registers the account AND signs the initial
      // mandate atomically. Server constructs the canonical Mandate
      // from the signed policy intent (see policy-to-mandate.ts).
      const bundle = await signPayload({
        context: "account_register_with_mandate",
        payload: {
          email: state.email,
          display_name: state.display_name,
          policy: state.policy,
          expires_at: expiresAt.toISOString(),
        },
        userHandle: state.email,
        minConfidence: "high",
      });
      await api.registerAccountWithMandate(bundle);
      router.push("/signup/connect");
    } catch (err) {
      console.error("[signup] sign+register failed", err);
      let msg: string;
      if (isVouchflowError(err)) {
        msg = `Signature failed: ${err.code}${err.message !== undefined && err.message.length > 0 ? ` — ${err.message}` : ""}`;
      } else if (err instanceof ApiClientError) {
        const bodyText =
          err.body !== null && typeof err.body === "object"
            ? JSON.stringify(err.body)
            : typeof err.body === "string"
              ? err.body
              : "";
        msg = `Server rejected (${err.status})${bodyText.length > 0 ? `: ${bodyText}` : ""}`;
      } else {
        msg = `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
      }
      setError(msg);
      setErrorObj(err);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <MandateReview policy={state.policy} expiresAt={expiresAt} />
      <p className="text-sm text-[color:var(--color-text-soft)]">
        Your device will create a passkey for Trusty Squire on the first sign — no separate setup
        step.
      </p>
      {error !== null ? (
        <div className="space-y-2">
          <p role="alert" className="text-[color:var(--color-accent)] text-sm">
            {error}
          </p>
          <VouchflowDiagnostics err={errorObj} />
        </div>
      ) : null}
      <Button onClick={onSign} disabled={pending} className="w-full">
        {pending ? "Signing…" : "Sign with passkey"}
      </Button>
    </div>
  );
}
