export type {
  CredentialRecord,
  CredentialStore,
  VaultAuditEventInput,
  VaultAuditPayload,
  VaultAuditStore,
  VaultAuditType,
  VaultRequester,
} from "./types.js";

export { VAULT_AUDIT_TYPES } from "./types.js";

export {
  CredentialVault,
  CredentialNotFoundError,
  StaleAssertionError,
  VaultRateLimitError,
  GrantNotUsableError,
  AccessGrantsNotConfiguredError,
  type CredentialVaultDeps,
  type VaultEntry,
  type VaultStoreInput,
  type RotateResult,
  type RequestAccessInput,
  type ProxyHttpTemplate,
  type ProxyResponse,
  type ProxyExecutor,
} from "./credential-vault.js";

export {
  InMemoryAccessGrantStore,
  effectiveGrantStatus,
  PENDING_TTL_SECONDS,
  DEFAULT_PERSISTENT_TTL_SECONDS,
  MAX_PERSISTENT_TTL_SECONDS,
  type AccessGrantRecord,
  type AccessGrantStore,
  type GrantIntent,
  type GrantMode,
  type GrantStatus,
} from "./access-grant.js";

export {
  KNOWN_SERVICE_HOSTS,
  deriveAllowedHosts,
} from "./service-hosts.js";

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
