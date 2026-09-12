# Payment approval repair acceptance

The repair's persistence, cardless ceremony, audit, and notification acceptance
criteria follow the [payment approval API contract](../apps/api/README.md#endpoints).

Payment review and approval authentication follow the
[card security contract](../SECURITY.md#client-encrypted-card-data).
The sessionless signed-approval regression is covered by
`apps/api/src/__tests__/pay-approvals.test.ts` (“lets a Telegram-link holder
review and submit a verified mandate without a web session”).
