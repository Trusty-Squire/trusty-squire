import { Vouchflow } from "@vouchflow/web";

let client: ReturnType<typeof Vouchflow.configure> | undefined;

export function getVouchflow() {
  if (client) {
    return client;
  }

  // Read at call time so builds and previews can load this module unconfigured.
  const apiKey = process.env.NEXT_PUBLIC_VOUCHFLOW_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "Vouchflow is not configured (NEXT_PUBLIC_VOUCHFLOW_API_KEY unset)",
    );
  }

  client = Vouchflow.configure({
    apiKey,
    // NEXT_PUBLIC_VOUCHFLOW_ENVIRONMENT is "sandbox" | "live".
    environment:
      process.env.NEXT_PUBLIC_VOUCHFLOW_ENVIRONMENT === "live"
        ? "production"
        : "sandbox",
    rpId: window.location.hostname,
    rpName: "Trusty Squire",
  });

  return client;
}
