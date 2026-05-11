// Shared inbox harness for runtime tests. Builds a real InboxService
// against in-memory stores so tests get behaviour-fidelity without
// mocking each method individually.

import {
  InboxService,
  InMemoryAliasStore,
  InMemoryEmailStore,
  buildReceivedEmail,
  type ReceivedEmail,
} from "@trusty-squire/inbox";

export interface InboxHarness {
  inbox: InboxService;
  aliasStore: InMemoryAliasStore;
  emailStore: InMemoryEmailStore;
  // Drop a fake email into the inbox so a wait_for_email step finds it.
  deliver: (alias: string, overrides?: Partial<ReceivedEmail>) => Promise<void>;
}

export function makeInboxHarness(opts: { now?: () => Date; sleep?: (ms: number) => Promise<void> } = {}): InboxHarness {
  const aliasStore = new InMemoryAliasStore();
  const emailStore = new InMemoryEmailStore();
  const inbox = new InboxService({
    aliasStore,
    emailStore,
    domain: "test.local",
    pollIntervalMs: 1,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.sleep !== undefined ? { sleep: opts.sleep } : {}),
  });
  return {
    inbox,
    aliasStore,
    emailStore,
    deliver: async (alias, overrides = {}) => {
      const email = buildReceivedEmail({
        alias,
        associated_run_id: null,
        message_id: `msg-${Math.random()}`,
        from_address: "noreply@test.local",
        from_domain: "test.local",
        subject: "Test",
        s3_raw_uri: "s3://test/x",
        body_text: "code 482915 click https://test.local/verify",
        body_html: null,
        parsed_links: ["https://test.local/verify"],
        parsed_codes: ["482915"],
        received_at: new Date(),
        ...overrides,
      });
      await emailStore.insertIfAbsent(email);
    },
  };
}
