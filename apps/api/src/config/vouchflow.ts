// Vouchflow configuration for the API.
//
// JWS verification reads the public JWKS at
// `https://vouchflow.dev/.well-known/jwks.json` — no API key required.
// The read-side keys below are baked in for future server-side queries
// (revocation lookups beyond the webhook, device introspection, etc.)
// so they're ready when those code paths land.
//
// `customerId` binds Vouchflow assertions to the Trusty Squire SaaS
// customer. Defaults to `ts-prod`; override with VOUCHFLOW_CUSTOMER_ID
// only when running an isolated Vouchflow customer in CI.

const SANDBOX_READ_KEY = "vsk_sandbox_read_02ae24558fef020f77783c480f6c09e74211871a";
const PRODUCTION_READ_KEY = "vsk_live_read_22528f7602be72f39a642d790331ed6fb273845b";

export type VouchflowEnvironment = "sandbox" | "production";

export interface VouchflowApiConfig {
  customerId: string;
  readKey: string;
  environment: VouchflowEnvironment;
}

export function loadVouchflowConfig(): VouchflowApiConfig {
  const environment: VouchflowEnvironment =
    process.env.VOUCHFLOW_ENV === "production" ? "production" : "sandbox";
  return {
    customerId: process.env.VOUCHFLOW_CUSTOMER_ID ?? "ts-prod",
    readKey:
      process.env.VOUCHFLOW_READ_KEY ??
      (environment === "production" ? PRODUCTION_READ_KEY : SANDBOX_READ_KEY),
    environment,
  };
}

export function isStubMode(): boolean {
  return process.env.VOUCHFLOW_STUB_MODE === "true";
}
