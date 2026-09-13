import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  acquireProfileOperationGuard,
  CHROME_PROFILE_DIR,
  ProfileBusyError,
  profilePathIdentity,
} from "../profile.js";
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

const retainedCredentials = new Map<string, string>();

export function requireLineageCredential(profileDir = CHROME_PROFILE_DIR): string {
  const explicit = process.env.TRUSTY_SQUIRE_FORWARDER_CREDENTIAL;
  if (explicit !== undefined) {
    forwarderId(explicit);
    return explicit;
  }
  const profile = profilePathIdentity(profileDir);
  const retained = retainedCredentials.get(profile);
  if (retained !== undefined) return retained;
  for (let slot = 0; ; slot++) {
    const root = join(profile, "trusty-squire-forwarders", String(slot));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    let lease;
    try {
      lease = acquireProfileOperationGuard(profile, root);
    } catch (error) {
      if (error instanceof ProfileBusyError) continue;
      throw error;
    }
    try {
      const path = join(root, "credential");
      let credential: string;
      try {
        credential = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        credential = randomBytes(32).toString("base64url");
        const temporary = join(root, "credential.pending");
        writeFileSync(temporary, credential, { mode: 0o600, flush: true });
        renameSync(temporary, path);
      }
      forwarderId(credential);
      retainedCredentials.set(profile, credential);
      process.once("exit", () => lease.release());
      return credential;
    } catch (error) {
      lease.release();
      throw error;
    }
  }
}
