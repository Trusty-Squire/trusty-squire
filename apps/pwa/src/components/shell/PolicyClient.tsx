"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import { api, ApiClientError } from "@/lib/api-client";
import { defaultPolicy, type MandatePolicy } from "@/lib/mandate";
import { signPayload, isVouchflowError } from "@/lib/vouchflow";
import { VouchflowDiagnostics } from "@/components/auth/VouchflowDiagnostics";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function PolicyClient() {
  const [policy, setPolicy] = useState<MandatePolicy | null>(null);
  const [email, setEmail] = useState<string>("");
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [errorObj, setErrorObj] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.activeMandate();
        if (cancelled) return;
        const loaded =
          res.mandate !== null && typeof res.mandate.policy === "object" && res.mandate.policy !== null
            ? (res.mandate.policy as MandatePolicy)
            : defaultPolicy();
        setPolicy(loaded);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiClientError && err.status === 401) {
          setMsg("Sign in to view your policy.");
        }
        setPolicy(defaultPolicy());
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave() {
    if (policy === null || email.length === 0) {
      setMsg("Enter your email to confirm.");
      return;
    }
    setPending(true);
    setMsg(null);
    setErrorObj(null);
    try {
      const bundle = await signPayload({
        context: "mandate_signing",
        payload: { email, policy, expires_at: new Date(Date.now() + ONE_YEAR_MS).toISOString() },
        userHandle: email,
        minConfidence: "high",
      });
      await api.createMandate(bundle);
      setMsg("Policy updated.");
    } catch (err) {
      console.error("[policy] save failed", err);
      setMsg(
        isVouchflowError(err)
          ? `Signature failed: ${err.code}${err.message !== undefined && err.message.length > 0 ? ` — ${err.message}` : ""}`
          : "Could not save policy.",
      );
      setErrorObj(err);
    } finally {
      setPending(false);
    }
  }

  if (policy === null) return <p className="text-[color:var(--color-ink-soft)]">Loading…</p>;

  return (
    <div className="space-y-6 max-w-2xl">
      <PolicyEditor value={policy} onChange={setPolicy} />
      <div className="border-t border-[color:var(--color-rule)] pt-4 space-y-3">
        <label className="block text-sm">
          <span className="block mb-1">Confirm email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-[color:var(--color-rule)] bg-white"
            placeholder="you@example.com"
          />
        </label>
        {msg !== null ? (
          <p role="status" className="text-sm text-[color:var(--color-ink-soft)]">{msg}</p>
        ) : null}
        <VouchflowDiagnostics err={errorObj} />
        <Button onClick={onSave} disabled={pending}>
          {pending ? "Signing…" : "Save policy"}
        </Button>
      </div>
    </div>
  );
}
