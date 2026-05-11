export type {
  CredentialRecord,
  CredentialStore,
  VaultAuditEventInput,
  VaultAuditPayload,
  VaultAuditStore,
  VaultRequester,
} from "./types.js";

export {
  CredentialVault,
  CredentialNotFoundError,
  StaleAssertionError,
  VaultRateLimitError,
  type CredentialVaultDeps,
} from "./credential-vault.js";

export {
  type KMSClient,
  LocalKMS,
  LocalKMSConfigError,
} from "./kms-client.js";

export {
  EncryptionError,
  aadForDek,
  aadForValue,
  decryptAesGcm,
  encryptAesGcm,
  generateKey,
} from "./encryption.js";

export { KekDerivationError, deriveSessionKEK } from "./kek-derivation.js";

export {
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  type InMemoryAuditEvent,
} from "./in-memory-stores.js";
