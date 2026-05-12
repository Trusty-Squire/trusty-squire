"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { loadSignup, saveSignup, initialSignup } from "./signup-state";

export function SignupStepIntro() {
  const router = useRouter();
  const initial = loadSignup() ?? initialSignup();
  const [email, setEmail] = useState(initial.email);
  const [displayName, setDisplayName] = useState(initial.display_name);
  const [errors, setErrors] = useState<{ email?: string; display_name?: string }>({});

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = "Enter a valid email address.";
    if (displayName.trim().length < 1) next.display_name = "Pick a display name.";
    if (Object.keys(next).length > 0) {
      setErrors(next);
      return;
    }
    saveSignup({ ...initial, email: email.trim(), display_name: displayName.trim() });
    router.push("/signup/policy");
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
        error={errors.email}
      />
      <Field
        label="Display name"
        name="display_name"
        autoComplete="name"
        required
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        hint="How your squire addresses you in receipts."
        error={errors.display_name}
      />
      <Button type="submit" className="w-full">
        Continue
      </Button>
    </form>
  );
}
