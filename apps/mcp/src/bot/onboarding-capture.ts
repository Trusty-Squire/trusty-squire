// onboarding-capture.ts — capture post-OAuth onboarding rounds into
// the E1 eval-corpus format.
//
// Building per-service onboarding adapters needs many iterations, but
// re-running the live OAuth handshake is rate-limited by Google
// anti-abuse (see the plan's Post-Build Findings). The escape: capture
// each onboarding round's real page state ONCE, then iterate the
// onboarding planner offline against the capture via eval-onboarding.ts.
//
// This is the capture half. Each round of postVerifyLoop is dumped as
// one JSON file shaped like an eval-onboarding.ts OnboardingEvalCase —
// minus `expect`, which is a human judgement (the correct next step).
// A curator fills `expect` in to make the case scorable; the eval
// harness loads only cases that have it.
//
// Inert unless TRUSTY_SQUIRE_ONBOARDING_CAPTURE names a directory —
// production never sets it (same env-gated pattern as debug.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractiveElement } from "./browser.js";
import type { PostVerifyStep } from "./agent.js";

// One run-scoped id so a multi-service process (the batch harness)
// keeps each service's rounds grouped without collisions.
let runId: string | undefined;

export interface OnboardingRoundCapture {
  service: string;
  round: number;
  oauth: boolean;
  state: { url: string; title: string; html: string; screenshot: string };
  inventory: readonly InteractiveElement[];
  // The step the planner actually chose this round — a reference for
  // the curator, NOT ground truth (the planner may have been wrong).
  observed: PostVerifyStep;
}

// Dump one onboarding round to the capture directory, if configured.
// Best-effort: a capture failure must never break a signup run.
export function captureOnboardingRound(entry: OnboardingRoundCapture): void {
  const dir = process.env.TRUSTY_SQUIRE_ONBOARDING_CAPTURE;
  if (dir === undefined || dir.trim().length === 0) return;
  try {
    mkdirSync(dir, { recursive: true });
    if (runId === undefined) runId = Date.now().toString(36);
    const slug = entry.service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const file = join(dir, `${slug}-${runId}-r${entry.round}.json`);
    // OnboardingEvalCase shape, with `expect: null` — the curator
    // replaces null with an OnboardingExpectation to make it scorable.
    const corpusCase = {
      name: `${entry.service} — onboarding round ${entry.round + 1}`,
      service: entry.service,
      oauth: entry.oauth,
      state: entry.state,
      inventory: entry.inventory,
      observed: entry.observed,
      expect: null,
    };
    writeFileSync(file, JSON.stringify(corpusCase, null, 2));
  } catch {
    // best-effort — capture is diagnostic, never load-bearing
  }
}
