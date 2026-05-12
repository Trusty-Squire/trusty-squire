// Multi-step signup state. Lives in sessionStorage so each step page
// can be a server component that bootstraps a small client island for
// the WebAuthn ceremony at the end.
//
// Passkey enrollment happens automatically on first signPayload — the
// Vouchflow SDK auto-enrolls when no credential exists for the given
// userHandle. No explicit enroll() step in the flow.

"use client";

import type { MandatePolicy } from "@/lib/mandate";
import { defaultPolicy } from "@/lib/mandate";

const KEY = "squire.signup";

export interface SignupState {
  email: string;
  display_name: string;
  policy: MandatePolicy;
}

export function loadSignup(): SignupState | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SignupState;
  } catch {
    return null;
  }
}

export function saveSignup(state: SignupState): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(KEY, JSON.stringify(state));
}

export function clearSignup(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(KEY);
}

export function initialSignup(): SignupState {
  return { email: "", display_name: "", policy: defaultPolicy() };
}
