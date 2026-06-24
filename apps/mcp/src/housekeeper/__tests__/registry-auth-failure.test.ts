// isRegistryAuthFailure — a 401 on the registry admin surface must fail the
// housekeeper loop LOUDLY (non-zero exit), not log "sleeping" and exit 0. The
// verify phase was silently dead Jun 17–24 2026 because a bearer-drift 401 was
// swallowed as a benign error. This guards the detector that prevents a repeat.

import { describe, expect, it } from "vitest";
import { isRegistryAuthFailure } from "../orchestrator.js";

describe("isRegistryAuthFailure", () => {
  it("fires on the exact fetchQueue 401 that hid the bearer drift", () => {
    expect(
      isRegistryAuthFailure(
        new Error('fetchQueue: 401 Unauthorized — {"ok":false,"error":"unauthorized"}'),
      ),
    ).toBe(true);
  });

  it("fires on a generic /admin/ 401 / unauthorized", () => {
    expect(isRegistryAuthFailure(new Error("GET /admin/verifier/queue -> 401"))).toBe(true);
    expect(isRegistryAuthFailure(new Error("admin bearer unauthorized"))).toBe(true);
  });

  it("does NOT fire on transient network / non-auth errors (those should sleep + retry)", () => {
    expect(isRegistryAuthFailure(new Error("fetch failed: ECONNREFUSED"))).toBe(false);
    expect(isRegistryAuthFailure(new Error("fetchQueue: 503 Service Unavailable"))).toBe(false);
    expect(isRegistryAuthFailure(new Error("a discover run timed out (401 seconds)"))).toBe(false);
  });
});
