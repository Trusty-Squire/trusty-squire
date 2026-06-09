// The single-escalation guarantee at the store + policy level: an unknown state
// is retried up to UNKNOWN_ESCALATION_THRESHOLD on the SAME (service,signature)
// — counted ACROSS passes via the persistent file — and escalates exactly once.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordUnknownState, markEscalated } from "../unknown-state-store.js";
import { shouldEscalate, UNKNOWN_ESCALATION_THRESHOLD } from "@trusty-squire/skill-schema";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ts-unknown-"));
  process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE = join(dir, "unknown-states.json");
});
afterEach(() => {
  delete process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = "2026-06-09T00:00:00.000Z";

describe("unknown-state escalation guarantee", () => {
  it("counts across passes and escalates exactly once, at the 3rd attempt", () => {
    const args = { service: "weirdsvc", signature: "sig-abc", now: NOW };

    const r1 = recordUnknownState(args);
    expect(r1.attempts).toBe(1);
    expect(shouldEscalate("unknown", r1.attempts)).toBe(false);

    const r2 = recordUnknownState(args);
    expect(r2.attempts).toBe(2);
    expect(shouldEscalate("unknown", r2.attempts)).toBe(false);

    const r3 = recordUnknownState(args);
    expect(r3.attempts).toBe(UNKNOWN_ESCALATION_THRESHOLD); // 3
    expect(shouldEscalate("unknown", r3.attempts)).toBe(true);
    expect(r3.alreadyEscalated).toBe(false);

    // The loop pings once, then marks it escalated so it never pings again.
    markEscalated(args.service, args.signature);
    const r4 = recordUnknownState(args);
    expect(r4.attempts).toBe(4);
    expect(r4.alreadyEscalated).toBe(true); // suppressed — no second human ping
  });

  it("a DIFFERENT signature on the same service is its own fresh count", () => {
    recordUnknownState({ service: "svc", signature: "sig-A", now: NOW });
    recordUnknownState({ service: "svc", signature: "sig-A", now: NOW });
    const b = recordUnknownState({ service: "svc", signature: "sig-B", now: NOW });
    expect(b.attempts).toBe(1); // not 3 — distinct novel state
    expect(shouldEscalate("unknown", b.attempts)).toBe(false);
  });

  it("a missing/unwritable store degrades to count=1 (never throws)", () => {
    process.env.TRUSTY_SQUIRE_UNKNOWN_STATE_FILE = join(dir, "nested", "deep", "x.json");
    const r = recordUnknownState({ service: "s", signature: "z", now: NOW });
    expect(r.attempts).toBe(1);
  });
});
