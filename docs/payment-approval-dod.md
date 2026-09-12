# Payment approval repair acceptance

The repair's persistence, cardless ceremony, audit, and notification acceptance
criteria follow the [payment approval API contract](../apps/api/README.md#endpoints).

The captain's no-separate-web-login delivery requirement is handled operationally
by running the operator on the correct Telegram-linked account, in a separate
account-configuration workstream. This repair does not redesign authentication:
`requireWeb`, owner checks, and passkey checks remain in place.
