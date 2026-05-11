"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import { loadSignup, saveSignup } from "./signup-state";
import type { MandatePolicy } from "@/lib/mandate";
import { defaultPolicy } from "@/lib/mandate";

export function SignupStepPolicy() {
  const router = useRouter();
  const initial = loadSignup();
  const [policy, setPolicy] = useState<MandatePolicy>(initial?.policy ?? defaultPolicy());

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (initial === null) {
      router.push("/signup");
      return;
    }
    saveSignup({ ...initial, policy });
    router.push("/signup/sign");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <PolicyEditor value={policy} onChange={setPolicy} />
      <Button type="submit" className="w-full">
        Review mandate
      </Button>
    </form>
  );
}

export { Field };
