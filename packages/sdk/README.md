<p align="center">
  <a href="https://trustysquire.ai" target="_blank" rel="noopener noreferrer">
    <img width="84" height="84" src="https://raw.githubusercontent.com/Trusty-Squire/trusty-squire/main/apps/web/public/logo-400.png" alt="Trusty Squire shield" />
  </a>
</p>

<h1 align="center">@trusty-squire/sdk</h1>

<p align="center">Use a user's vaulted keys and show their passkey approvals inside your own app.</p>

For coding agents, use the MCP server instead: [`@trusty-squire/mcp`](https://github.com/Trusty-Squire/trusty-squire/tree/main/apps/mcp).

```sh
npm i @trusty-squire/sdk
```

```ts
import { Squire, openApproval } from "@trusty-squire/sdk";

const squire = new Squire({ token: userSquireToken, agentName: "My App" });

// Call an API. Squire injects the key; your app never sees it.
await squire.credentials.use({
  service: "stripe",
  http: { method: "GET", url: "https://api.stripe.com/v1/balance",
          headers: { authorization: "Bearer ${SECRET}" } },
});

// Risky actions return an approval. The user signs with their passkey.
const { approval } = await squire.credentials.requestReveal({ service: "openai" });
approveButton.onclick = () => openApproval(approval); // browser side
const { value } = await squire.credentials.claimReveal(approval.id, { timeoutMs: 60_000 });
```

Full API: see the types and JSDoc in [`src/`](https://github.com/Trusty-Squire/trusty-squire/tree/main/packages/sdk/src).
