export type {
  CredentialRecord,
  CredentialStore,
  CredentialType,
  VaultAuditEventInput,
  VaultAuditListOptions,
  VaultAuditPayload,
  VaultAuditRecord,
  VaultAuditStore,
  VaultAuditType,
  VaultRequester,
} from "./types.js";

export { VAULT_AUDIT_TYPES } from "./types.js";

export {
  CredentialVault,
  coerceFieldMap,
  CredentialNotFoundError,
  FieldExistsError,
  StaleAssertionError,
  VaultRateLimitError,
  AllowlistViolationError,
  RestoreConflictError,
  DEFAULT_LABEL,
  type CredentialVaultDeps,
  type VaultEntry,
  type VaultStoreInput,
  type RotateResult,
  type VaultHealthResult,
  type VaultAccountExport,
  type VaultCredentialExport,
  type DeviceAssertion,
  type ProxyHttpTemplate,
  type ProxyResponse,
  type ProxyExecutor,
} from "./credential-vault.js";

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
