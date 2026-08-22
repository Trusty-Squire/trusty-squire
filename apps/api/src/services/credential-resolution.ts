import type { CredentialRecord, CredentialStore } from "@trusty-squire/vault";

export interface CredentialSelector {
  reference?: string;
  service?: string;
  name?: string;
}

export type CredentialResolution =
  | { kind: "found"; credential: CredentialRecord }
  | { kind: "missing" }
  | { kind: "ambiguous"; candidates: CredentialRecord[] };

export async function resolveCredentialForAccount(
  store: CredentialStore,
  accountId: string,
  selector: CredentialSelector,
): Promise<CredentialResolution> {
  const owned = await store.listByAccount(accountId);
  if (selector.reference !== undefined) {
    const credential = owned.find((candidate) => candidate.reference === selector.reference);
    return credential === undefined ? { kind: "missing" } : { kind: "found", credential };
  }
  const service = selector.service?.toLowerCase();
  const matches = owned.filter((candidate) => {
    const candidateService =
      typeof candidate.metadata.service === "string"
        ? candidate.metadata.service.toLowerCase()
        : null;
    return (
      (service === undefined || candidateService === service) &&
      (selector.name === undefined || candidate.label === selector.name)
    );
  });
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
  return { kind: "found", credential: matches[0]! };
}
