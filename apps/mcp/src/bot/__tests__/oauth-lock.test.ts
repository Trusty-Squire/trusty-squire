// T8 — withOAuthLock serializes OAuth signup runs. Two runs share the
// one persistent Chrome profile, which Chrome single-instances; the
// lock makes a second run queue behind the first (D2) rather than
// corrupting the profile lock.

import { describe, expect, it } from "vitest";
import { withOAuthLock } from "../oauth-lock.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe("withOAuthLock", () => {
  it("runs queued tasks strictly one at a time, in arrival order", async () => {
    const events: string[] = [];
    const task = (id: string) => async (): Promise<void> => {
      events.push(`start ${id}`);
      await tick();
      events.push(`end ${id}`);
    };

    const a = withOAuthLock(task("A"));
    const b = withOAuthLock(task("B"));
    const c = withOAuthLock(task("C"));
    await Promise.all([a, b, c]);

    // No interleaving: each task fully finishes before the next starts.
    expect(events).toEqual([
      "start A",
      "end A",
      "start B",
      "end B",
      "start C",
      "end C",
    ]);
  });

  it("releases the lock even when a task rejects, so the queue keeps moving", async () => {
    const events: string[] = [];
    const failing = withOAuthLock(async () => {
      events.push("failing ran");
      throw new Error("boom");
    });
    const next = withOAuthLock(async () => {
      events.push("next ran");
    });

    await expect(failing).rejects.toThrow("boom");
    await next;
    expect(events).toEqual(["failing ran", "next ran"]);
  });

  it("returns the wrapped task's resolved value", async () => {
    await expect(withOAuthLock(async () => 42)).resolves.toBe(42);
  });
});
