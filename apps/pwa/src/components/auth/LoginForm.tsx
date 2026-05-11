"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { signPayload, isVouchflowError } from "@/lib/vouchflow";
import { api, ApiClientError } from "@/lib/api-client";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const bundle = await signPayload({
        context: "login",
        payload: { email },
        userHandle: email,
        minConfidence: "low",
      });
      await api.login(bundle);
      router.push("/dashboard");
    } catch (err) {
      setError(
        isVouchflowError(err)
          ? `Sign-in failed: ${err.code}`
          : err instanceof ApiClientError
            ? `Server rejected: ${err.status}`
            : "Sign-in failed.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error ?? undefined}
      />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in with passkey"}
      </Button>
    </form>
  );
}
