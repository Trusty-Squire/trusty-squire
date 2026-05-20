"use client";

import { useSyncExternalStore } from "react";

// Reads a query-string param without next/navigation's useSearchParams
// (which forces a Suspense boundary) and without setState-in-effect
// (which the lint rule flags). The URL doesn't change here without a
// navigation, so subscribe is a no-op.
const noopSubscribe = (): (() => void) => () => {};

export function useQueryParam(key: string): string | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => new URLSearchParams(window.location.search).get(key),
    () => null,
  );
}
