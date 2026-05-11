"use client";

import { useEffect } from "react";
import { registerServiceWorker } from "@/lib/sw-register";

export function ServiceWorkerMount() {
  useEffect(() => {
    registerServiceWorker();
  }, []);
  return null;
}
