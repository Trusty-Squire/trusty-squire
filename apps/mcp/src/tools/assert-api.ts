// Leaf module so tool files that the registry cycle can reach (e.g.
// operate-decide, imported back through provision-drive) can assert the
// api-client without importing tools/index.js at module-evaluation time —
// index re-exports this for compatibility with the existing import surface.

import type { ApiClient } from "../api-client.js";

// All tools receive `api: ApiClient | null`. In the single-tier model
// server.ts only invokes a handler after confirming a non-null api, but
// the registry contract still types it as nullable. assertApi() is the
// one-liner that asserts the non-nullability for handlers that DO need the API.
export function assertApi(api: ApiClient | null): asserts api is ApiClient {
  if (api === null) {
    throw new Error(
      "This tool requires an active Trusty Squire session. Run `npx @trusty-squire/mcp connect`.",
    );
  }
}
