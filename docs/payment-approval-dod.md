# Payment approval repair acceptance

A cardless approval must persist before creation returns, load through the owner
ceremony, and appear in the existing unfiltered audit ledger and exact-type filter
(`vault.payment_approval_created`). Persistence or audit-write errors must fail
creation instead of returning an approval URL.

For a Telegram-linked account, creation must await notification delivery. A failed
send must record `vault.payment_approval_delivery_failed` and return an error.
The persisted approval remains available to its owner; a delivery error does not
authorize card release or payment.

The captain's no-separate-web-login delivery requirement is handled operationally
by running the operator on the correct Telegram-linked account, in a separate
account-configuration workstream. This repair does not redesign authentication:
`requireWeb`, owner checks, and passkey checks remain in place.
