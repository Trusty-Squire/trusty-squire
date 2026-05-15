// Vouchflow configuration for the API.
//
// JWS verification reads the public JWKS at
// `https://vouchflow.dev/.well-known/jwks.json` — no API key required.
// The server-side read key (revocation lookups, device introspection)
// is privileged and MUST come from the VOUCHFLOW_READ_KEY env var.
// Never hardcode it — a baked-in key is a public leak waiting to happen.
//
// `customerId` binds Vouchflow assertions to the Trusty Squire SaaS
// customer. Defaults to `ts-prod`; override with VOUCHFLOW_CUSTOMER_ID
// only when running an isolated Vouchflow customer in CI.

export type VouchflowEnvironment = "sandbox" | "production";

export interface VouchflowApiConfig {
  customerId: string;
  // undefined until VOUCHFLOW_READ_KEY is set; the server-side query
  // code paths that consume it must null-check.
  readKey: string | undefined;
  environment: VouchflowEnvironment;
}

export function loadVouchflowConfig(): VouchflowApiConfig {
  const environment: VouchflowEnvironment =
    process.env.VOUCHFLOW_ENV === "production" ? "production" : "sandbox";
  return {
    customerId: process.env.VOUCHFLOW_CUSTOMER_ID ?? "ts-prod",
    readKey: process.env.VOUCHFLOW_READ_KEY,
    environment,
  };
}

export function isStubMode(): boolean {
  return process.env.VOUCHFLOW_STUB_MODE === "true";
}
