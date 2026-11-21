import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api-client.js";
import {
  emptyDriveState,
  runOperateDrive,
  type DriveDependencies,
  type WireRow,
} from "../operate-drive.js";
import type { Session } from "../session/model.js";
import type { Observation } from "../provision-session.js";

const state = vi.hoisted(() => ({ session: undefined as Session | undefined }));
vi.mock("../session/lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session/lifecycle.js")>()),
  sessionForCall: () => state.session,
  liveProviderSessionsForSession: async () => [],
}));

const url = "https://signup.example.test/register";
const goal = "Create an ordinary free account";

describe("drive session email fact", () => {
  it.each([
    {
      sessionEmail: "owner@example.test",
      callerEmail: undefined,
      savedEmail: undefined,
      expected: "owner@example.test",
    },
    {
      sessionEmail: "owner@example.test",
      callerEmail: "caller@example.test",
      savedEmail: undefined,
      expected: "caller@example.test",
    },
    {
      sessionEmail: "owner@example.test",
      callerEmail: undefined,
      savedEmail: "retained@example.test",
      expected: "retained@example.test",
    },
    {
      sessionEmail: undefined,
      callerEmail: "caller@example.test",
      savedEmail: undefined,
      expected: "caller@example.test",
    },
    { sessionEmail: undefined, callerEmail: undefined, savedEmail: undefined, expected: undefined },
  ])(
    "types $expected from session=$sessionEmail, caller=$callerEmail, retained=$savedEmail",
    async ({ sessionEmail, callerEmail, savedEmail, expected }) => {
      state.session = {
        id: "email-unit",
        userEmail: sessionEmail,
        browser: { page: null, currentUrl: () => url },
        drive: savedEmail === undefined ? null : emptyDriveState(goal, { email: savedEmail }),
        lastElements: [],
        secretSlots: new Map(),
        committedSelectValues: new Map(),
        releasedPaymentCard: null,
        compactV2Secret: Buffer.alloc(32),
      } as unknown as Session;
      let typed: string | undefined;
      let choices = 0;
      const submitted = new Error("unit submit boundary");
      const driveAct = vi.fn<NonNullable<DriveDependencies["driveAct"]>>(async (_id, action) => {
        if (action.kind === "type") {
          expect(action.target).toBe("@email");
          expect(action.text).toBe(expected);
          typed = action.text;
          return { kind: "ok", combobox: false };
        }
        expect(action).toMatchObject({ kind: "click", target: "@submit" });
        expect(typed).toBe(expected);
        throw submitted;
      });
      const observe = vi.fn(
        async () =>
          ({
            session_id: "email-unit",
            url,
            safe_table: [
              ["@email", "t", `Email|f=email|fm=1|s=r${typed === undefined ? "" : `p|n=${typed}`}`],
              ["@submit", "b", "Buat Akun|a=submit|fm=1"],
            ] satisfies WireRow[],
          }) as unknown as Observation,
      );
      const askJev = vi.fn<DriveDependencies["askJev"]>(async (_api, _state, questions) => {
        choices += 1;
        if (expected !== undefined && typed === undefined) {
          expect(questions.TYPE_TEXT_target).toMatchObject({ type: "choice" });
          expect(state.session!.drive!.facts.email).toBe(expected);
        }
        if (typed !== undefined) {
          const click = questions.CLICK_target;
          expect(
            click?.type === "choice" && Object.values(click.criteria).includes("Buat Akun"),
          ).toBe(true);
        }
        return {
          attempts: 1,
          elapsedMs: 1,
          result: {
            answers: Object.fromEntries(
              Object.entries(questions).map(([name, question]) => {
                if (question.type !== "choice")
                  return [name, { noul: name === "dead_end" ? 0 : 1 }];
                const keys = Object.keys(question.criteria);
                const choice =
                  name === "operation"
                    ? expected === undefined
                      ? "BLOCKED"
                      : typed === undefined
                        ? "TYPE_TEXT"
                        : "CLICK"
                    : name === "email_code_field"
                      ? "none"
                      : name === "CLICK_target"
                        ? (keys.find((key) => question.criteria[key] === "Buat Akun") ?? keys[0]!)
                        : keys[0]!;
                return [
                  name,
                  {
                    choice,
                    confidence: 1,
                    probabilities: Object.fromEntries(
                      keys.map((key) => [key, key === choice ? 1 : 0]),
                    ),
                  },
                ];
              }),
            ),
          },
        };
      });
      const run = runOperateDrive(
        {
          session_id: "email-unit",
          goal,
          max_steps: 4,
          max_seconds: 5,
          ...(callerEmail === undefined ? {} : { facts: { email: callerEmail } }),
        },
        {} as ApiClient,
        undefined,
        {
          askJev,
          observe,
          driveAct,
          act: vi.fn(),
          startSession: vi.fn(),
          awaitVerification: vi.fn(),
          injectCard: vi.fn(),
        },
      );
      if (expected === undefined) {
        expect((await run).status).toBe("stuck");
        expect(driveAct).not.toHaveBeenCalled();
        expect(state.session!.drive!.facts.email).toBeUndefined();
      } else {
        await expect(run).rejects.toThrow(submitted);
        expect(driveAct).toHaveBeenCalledTimes(2);
        expect(choices).toBe(2);
      }
    },
  );
});
