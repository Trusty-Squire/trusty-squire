import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import { OAuthAwaitingHumanError } from "../oauth-login.js";
import { runOperateDrive, type DriveDependencies } from "../operate-drive.js";
import type { Session } from "../session/model.js";
import type { Observation } from "../provision-session.js";

const state = vi.hoisted(() => ({ session: undefined as Session | undefined }));
vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/lifecycle.js")>()),
  sessionForCall: () => state.session,
  liveProviderSessionsForSession: async () => [],
}));

// Reduced from the Numes/Openference rows in the 1.1.57-rc.1 bootstrap trace.
// A previous OAuth call still owns its popup while the product button remains
// visible. A second press must hand control back for observation, not advertise
// another resumable drive budget.
describe("drive pending OAuth handoff", () => {
  it.each([
    [
      "https://auth.numes.ai/realms/numes/protocol/openid-connect/auth",
      "Continue with GitHub Last used",
    ],
    ["https://openference.com/register", "Continue with GitHub"],
  ])("hands back the pending OAuth attempt on %s", async (url, label) => {
    const sessionId = "pending-oauth-unit";
    state.session = {
      id: sessionId,
      browser: { page: null, currentUrl: () => url },
      drive: null,
      lastElements: [],
      secretSlots: new Map(),
      committedSelectValues: new Map(),
      releasedPaymentCard: null,
      compactV2Secret: Buffer.alloc(32),
    } as unknown as Session;
    const observation = {
      session_id: sessionId,
      url,
      safe_table: [["@github", "b", label]],
    } as unknown as Observation;
    const reason =
      "An owned OAuth attempt is still pending. Call operate_observe or oauth_settle; a second authorization attempt was not started.";
    const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async () => {
      throw new OAuthAwaitingHumanError(reason);
    });
    const dependencies: DriveDependencies = {
      askJev: vi.fn(),
      act: vi.fn(),
      observe: vi.fn(async () => observation),
      startSession: vi.fn(),
      awaitVerification: vi.fn(),
      injectCard: vi.fn(),
      driveAct,
    };
    const result = await runOperateDrive(
      { session_id: sessionId, goal: "Sign up with GitHub", answer: "@github" },
      {} as ApiClient,
      undefined,
      dependencies,
    );
    expect(driveAct).toHaveBeenCalledOnce();
    expect(driveAct.mock.calls[0]?.[1]).toMatchObject({ kind: "oauth_login", provider: "github" });
    expect(result).toMatchObject({
      status: "awaiting_human",
      reason,
      oauth: { state: "awaiting_human", reason, next_action: "operate_observe" },
    });
    expect(result.steps).toBe(0);
    expect(state.session!.drive!.failedActionKeys).toEqual([]);
    expect(state.session!.drive!.consumedActionKey).toBeNull();
    expect(dependencies.askJev).not.toHaveBeenCalled();
  });
});
