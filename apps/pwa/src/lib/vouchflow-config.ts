// Vouchflow configuration baked into the v0 build.
//
// These are write-side keys: the Vouchflow Web SDK uses them in the
// browser to drive WebAuthn ceremonies. They're public by design — the
// SDK is meant to be embedded in client-side JavaScript and Vouchflow
// scopes each key to its registered rpId(s) + environment, so an
// attacker who copies a key can't use it from a different domain.
//
// We bake them in (rather than requiring per-deployment env config)
// because there's exactly one Trusty Squire SaaS instance. Anyone
// running this codebase locally hits the same Vouchflow customer
// (`ts-prod`) — that's intentional for v0.
//
// Override path (for testing alternate customers or a future
// self-hosted deployment): set NEXT_PUBLIC_VOUCHFLOW_API_KEY +
// NEXT_PUBLIC_VOUCHFLOW_ENV.

import type { Environment } from "@vouchflow/web";

const SANDBOX_API_KEY = "vsk_sandbox_20af25f2668a65ae268625ab2235e765153fe11b";
const PRODUCTION_API_KEY = "vsk_live_8fd101ea6cc4c73f995fe307568083d8fc60a191";

const PRODUCTION_HOSTNAMES = new Set(["app.trustysquire.ai", "trustysquire.ai"]);

export interface ResolvedVouchflowConfig {
  apiKey: string;
  environment: Environment;
  rpId: string;
  rpName: string;
}

export function resolveVouchflowConfig(): ResolvedVouchflowConfig {
  const envOverrideKey = process.env.NEXT_PUBLIC_VOUCHFLOW_API_KEY;
  const explicitEnv = process.env.NEXT_PUBLIC_VOUCHFLOW_ENV;
  const hostname = typeof window !== "undefined" ? window.location.hostname : "localhost";

  // Production when env explicitly says so OR the hostname is a known
  // production domain. Anything else (localhost, preview deploys, IPs)
  // stays on sandbox so we never accidentally burn real devices.
  const isProduction = explicitEnv === "production" || PRODUCTION_HOSTNAMES.has(hostname);
  const environment: Environment = isProduction ? "production" : "sandbox";

  const apiKey =
    envOverrideKey !== undefined && envOverrideKey.length > 0
      ? envOverrideKey
      : isProduction
        ? PRODUCTION_API_KEY
        : SANDBOX_API_KEY;

  return {
    apiKey,
    environment,
    rpId: hostname,
    rpName: "Trusty Squire",
  };
}
