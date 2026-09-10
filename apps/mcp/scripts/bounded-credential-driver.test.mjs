import { describe, expect, it, vi } from "vitest";
import { captureCredentialBaseline, provision } from "./bounded-credential-driver.mjs";

const run = { run_label: "trusty-squire-run-0" };

describe("bounded credential driver", () => {
  it("runs one reusable declarative driver and resolves observed evidence", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ dom: "account acct-1 old-key" })
      .mockResolvedValueOnce({ stored_credential: { reference: "vault://new" } })
      .mockResolvedValueOnce({
        dom: "trusty-squire-run-0 id=new-key created=2026-09-09T20:00:00Z",
      });
    const service = {
      driverEvidence: {
        baseline: {
          steps: [{ id: "page", tool: "operate_observe", require_pattern: "acct-1" }],
          evidence: {
            account_id: { literal: "acct-1" },
            provider_credential_ids: [{ literal: "old-key" }],
            initial_auth_state: { literal: "authenticated" },
          },
        },
        provision: {
          steps: [
            { id: "capture", tool: "operate_click", arguments: { ref: "@create" } },
            { id: "row", tool: "operate_observe", require_pattern: "$RUN_LABEL" },
          ],
          evidence: {
            provider_id: { step: "row", path: "dom", pattern: "id=(?<value>[^ ]+)" },
            label: { literal: "$RUN_LABEL" },
            account_id: { literal: "acct-1" },
            created_at: {
              step: "row",
              path: "dom",
              pattern: "created=(?<value>[^ ]+)",
              as: "timestamp",
            },
            vault_reference: { step: "capture", path: "stored_credential.reference" },
          },
        },
      },
    };

    await expect(
      captureCredentialBaseline({ call, sessionId: "session-1", run, service }),
    ).resolves.toEqual({
      account_id: "acct-1",
      provider_credential_ids: ["old-key"],
      initial_auth_state: "authenticated",
    });
    await expect(provision({ call, sessionId: "session-1", run, service })).resolves.toEqual({
      credential_policy: "force_fresh",
      provider_credential: {
        id: "new-key",
        label: "trusty-squire-run-0",
        account_id: "acct-1",
        created_at: Date.parse("2026-09-09T20:00:00Z"),
      },
      vault_reference: "vault://new",
    });
    expect(call).toHaveBeenCalledWith("operate_observe", { session_id: "session-1" }, 20_000);
  });

  it("rejects unbounded or unreviewed driver calls", async () => {
    await expect(
      captureCredentialBaseline({
        call: vi.fn(),
        sessionId: "session-1",
        run,
        service: {
          driverEvidence: {
            baseline: { steps: [{ id: "bad", tool: "use_credential" }], evidence: {} },
          },
        },
      }),
    ).rejects.toThrow(/Unreviewed driver tool/);
  });
});
