# operate_drive signup corpus (5)

Live evidence that `operate_drive` can carry an email signup to a vaulted API
key. Raw traces live outside the repo (`firstmate/data/ts-drive-signup-corpus-5`)
so page text never lands in git.

## Providers

| Provider | URL | Why |
| --- | --- | --- |
| Meilisearch | https://cloud.meilisearch.com/register | France; register reached welcome without email verify |
| CurrencyAPI | https://app.currencyapi.com/register | EverAPI (AT); dashboard key. Swap for Postmark public-domain gate |
| AbstractAPI | https://app.abstractapi.com/users/sign_up | Dashboard key after signup. Swap for IPInfo/Resend consent wall |
| Algolia | https://www.algolia.com/users/sign_up | France; app keys on first project. Swap for OpenRouter Clerk/email |
| Mistral | https://console.mistral.ai/ | France; console API keys. Extra swap candidate |

Original five (IPInfo, Resend, Postmark, OpenRouter `/sign-up`, Meilisearch) were the
starting set. Group A (Resend, IPInfo) stopped at inbox consent. Postmark rejected
public-domain plus-gmail. OpenRouter `/sign-up` is marketing nav. Those names are
not required — the captain asked for five vaulted keys.

A provider that demands a card, phone, or identity document is recorded and
replaced, not completed.

Signup identities are plus-addresses on the mailbox the signup-test-profile
Google session can read (`lunchboxfortwo+c5-<provider>-<rand>@gmail.com`).
`@trustysquire.ai` mail is not reachable by the operator inbox read; that is a
standing gap, not a loop fix. A provider that rejects plus-addressing is a
provider limitation, recorded in the ledger.
