import { createHash, randomBytes } from "node:crypto";
import { BrokerRefusal } from "./scheduler.js";

const CREDENTIAL = /^[A-Za-z0-9_-]{43,128}$/;

export function forwarderId(credential: string): string {
  if (!CREDENTIAL.test(credential))
    throw new BrokerRefusal(
      "forwarder_credential_invalid",
      "Forwarder lineage credential must be an unguessable base64url secret",
    );
  return createHash("sha256").update(credential).digest("hex");
}

export function requireLineageCredential(): string {
  const credential = process.env.TRUSTY_SQUIRE_FORWARDER_CREDENTIAL;
  // A new MCP process gets its own opaque lineage without launcher setup.
  // Launchers may retain an explicit credential to recover across stdio restarts.
  if (credential === undefined) return randomBytes(32).toString("base64url");
  forwarderId(credential);
  return credential;
}
