import { Vouchflow } from "@vouchflow/web";

let client: ReturnType<typeof Vouchflow.configure> | undefined;

export function getVouchflow() {
  if (client) {
    return client;
  }

  // Read at call time so builds and previews can load this module unconfigured.
  const apiKey = process.env.NEXT_PUBLIC_VOUCHFLOW_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Vouchflow is not configured (NEXT_PUBLIC_VOUCHFLOW_API_KEY unset)");
  }

  client = Vouchflow.configure({
    apiKey,
    // NEXT_PUBLIC_VOUCHFLOW_ENVIRONMENT is "sandbox" | "production" (the SDK's
    // Environment values). Anything other than "production" stays on sandbox.
    environment:
      process.env.NEXT_PUBLIC_VOUCHFLOW_ENVIRONMENT === "production" ? "production" : "sandbox",
    rpId: resolveRpId(process.env.NEXT_PUBLIC_VOUCHFLOW_RP_ID, window.location.hostname),
    rpName: "Trusty Squire",
  });

  return client;
}

/** A passkey remains bound to its configured relying party across supported hosts. */
export function resolveRpId(configured: string | undefined, hostname: string): string {
  const rpId = configured?.trim().toLowerCase();
  if (!rpId || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(rpId)) {
    throw new Error("Passkey address is missing or invalid. Contact support.");
  }
  const host = hostname.toLowerCase();
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    throw new Error(
      `Passkeys for ${rpId} cannot be used on this host. Open this approval on ${rpId}.`,
    );
  }
  return rpId;
}
