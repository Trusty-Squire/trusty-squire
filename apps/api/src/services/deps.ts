// Composition root: wires every package together into an `ApiDeps`
// object the routes consume.
//
// For dev + tests we use in-memory implementations. Production wires
// Prisma-backed equivalents in a separate module (out-of-package).

import { Buffer } from "node:buffer";
import {
  InMemoryAdapterRegistry,
  InMemoryRunStore,
  type AdapterRegistry,
  type RunStore,
  type VaultClient,
} from "@trusty-squire/runtime";
import { resendDemoManifest } from "@trusty-squire/adapter-resend";
import { InboxService, InMemoryAliasStore, InMemoryEmailStore } from "@trusty-squire/inbox";
import {
  CredentialVault,
  InMemoryCredentialStore,
  InMemoryVaultAuditStore,
  LocalKMS,
} from "@trusty-squire/vault";
import {
  MandateValidator,
  VouchflowVerifier,
  type MandateValidatorDeps,
} from "@trusty-squire/mandate-validator";
import {
  InMemoryAgentSessionStore,
  type AgentSessionStore,
} from "../auth/agent.js";
import {
  InMemoryApprovalTokenStore,
  type ApprovalTokenStore,
} from "../auth/approval-token.js";
import {
  InMemoryPairingTokenStore,
  type PairingTokenStore,
} from "../auth/pairing-token.js";
import {
  InMemorySessionStore,
  type SessionStore,
} from "../auth/session.js";
import {
  InMemoryAccountStore,
  type AccountStore,
} from "./in-memory-account-store.js";

export interface ApiDeps {
  // Identity / auth
  accountStore: AccountStore;
  sessionStore: SessionStore;
  agentSessionStore: AgentSessionStore;
  approvalTokenStore: ApprovalTokenStore;
  pairingTokenStore: PairingTokenStore;

  // Runtime
  runStore: RunStore;
  adapterRegistry: AdapterRegistry;
  vault: VaultClient;
  inbox: InboxService;

  // Mandate validation
  mandateValidator: MandateValidator;
  validatorDeps: MandateValidatorDeps;
  vouchflowVerifier: VouchflowVerifier;

  // Config
  sessionSecret: string;
  customerId: string;

  // Test injection
  now?: () => Date;
}

export interface BuildInMemoryDepsOpts {
  sessionSecret: string;
  customerId: string;
  // Override the Vouchflow JWKS for tests (so we can sign locally).
  vouchflowVerifier?: VouchflowVerifier;
  now?: () => Date;
}

export function buildInMemoryDeps(opts: BuildInMemoryDepsOpts): ApiDeps {
  const accountStore = new InMemoryAccountStore();
  const sessionStore = new InMemorySessionStore();
  const agentSessionStore = new InMemoryAgentSessionStore();
  const approvalTokenStore = new InMemoryApprovalTokenStore();
  const pairingTokenStore = new InMemoryPairingTokenStore();

  const runStore = new InMemoryRunStore();
  const adapterRegistry = new InMemoryAdapterRegistry();

  // Demo mode preloads the mock-target Resend manifest so `pnpm demo`
  // can run the full provisioning loop end-to-end without a separate
  // registry-api process. Production wires a RegistryClient against
  // the live registry-api in its own composition root.
  if (process.env.DEMO_MODE === "true") {
    adapterRegistry.register(resendDemoManifest);
  }

  const credentialStore = new InMemoryCredentialStore();
  const vaultAuditStore = new InMemoryVaultAuditStore();
  const kms = LocalKMS.withFixedKey(Buffer.alloc(32, 0x7f));
  const vault = new CredentialVault({ store: credentialStore, audit: vaultAuditStore, kms });

  const inbox = new InboxService({
    aliasStore: new InMemoryAliasStore(),
    emailStore: new InMemoryEmailStore(),
    domain: "test.local",
    pollIntervalMs: 1,
  });

  const usedNonces = new Set<string>();
  const revokedMandates = new Set<string>();
  const validatorDeps: MandateValidatorDeps = {
    recordNonce: async (n) => {
      usedNonces.add(n);
    },
    isNonceUsed: async (n) => usedNonces.has(n),
    getRecentSpend: async () => 0,
    getProvisionedServices: async () => [],
    getProvisionedCategories: async () => [],
    getRevokedMandates: async () => revokedMandates,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };

  const vouchflowVerifier =
    opts.vouchflowVerifier ?? new VouchflowVerifier({ customerId: opts.customerId });
  const mandateValidator = new MandateValidator(validatorDeps, vouchflowVerifier);

  return {
    accountStore,
    sessionStore,
    agentSessionStore,
    approvalTokenStore,
    pairingTokenStore,
    runStore,
    adapterRegistry,
    vault,
    inbox,
    mandateValidator,
    validatorDeps,
    vouchflowVerifier,
    sessionSecret: opts.sessionSecret,
    customerId: opts.customerId,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}
