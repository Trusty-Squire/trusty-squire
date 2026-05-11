// Service-worker registration. Two responsibilities:
//   1. Only register in production (localhost dev is HTTPS-loose and we
//      don't want stale shell caches confusing iteration).
//   2. Detect a waiting worker — when sw.js changes, Chrome installs
//      the new SW but keeps it `waiting` until all tabs close. We
//      surface this via a one-time `console.warn` so the user can
//      reload to update. A toast UI is overkill for v0.
//
// This module is a SIDE-EFFECT import: load it from layout.tsx and the
// effect happens once per app load.

"use client";

const REGISTER = "trusty-squire/sw-register";

export function registerServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") return;

  window.addEventListener(
    "load",
    () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          // If there's a worker waiting at register-time, surface it.
          if (reg.waiting) notifyUpdate(reg);
          reg.addEventListener("updatefound", () => {
            const installing = reg.installing;
            if (installing === null) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed" && navigator.serviceWorker.controller !== null) {
                notifyUpdate(reg);
              }
            });
          });
        })
        .catch((err: unknown) => {
          console.warn(`[${REGISTER}] registration failed`, err);
        });
    },
    { once: true },
  );
}

function notifyUpdate(reg: ServiceWorkerRegistration): void {
  console.warn(`[${REGISTER}] new version available — reload to update`);
  // Hand the waiting worker the signal to take over. Some users won't
  // notice the console message; the next navigation will pick up the
  // new SW once it activates anyway.
  reg.waiting?.postMessage({ type: "SKIP_WAITING" });
}
