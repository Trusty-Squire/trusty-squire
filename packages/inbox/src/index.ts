export type {
  AliasStore,
  CreateAliasInput,
  EmailAliasRecord,
  EmailMatcher,
  EmailStore,
  ReceivedEmail,
  WaitForEmailInput,
} from "./types.js";

export {
  AliasInactiveError,
  EmailTimeoutError,
  EncryptedEmailError,
  InboxError,
} from "./types.js";

export {
  InboxService,
  buildReceivedEmail,
  emailMatches,
  type InboxServiceDeps,
} from "./inbox-service.js";

export {
  MailgunHandler,
  type MailgunHandlerDeps,
  type MailgunInboundPayload,
} from "./mailgun-handler.js";

export {
  ResendHandler,
  type ResendHandlerDeps,
  type ResendInboundPayload,
  type ResendIngestOutcome,
} from "./resend-handler.js";

export {
  extractLinks,
  extractOtp,
  matchString,
  parseRfc822,
  type ParsedEmail,
} from "./parser.js";

export {
  accountHandle,
  generateAlias,
  serviceSlug,
  type AliasGeneratorOptions,
} from "./alias-generator.js";

export { InMemoryAliasStore, InMemoryEmailStore } from "./in-memory-stores.js";
export { PrismaAliasStore, PrismaEmailStore } from "./prisma-stores.js";
