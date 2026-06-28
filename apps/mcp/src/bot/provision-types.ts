// provision-types.ts — the two shared result/step types the provision
// pipeline passes between the capture, synthesis, replay, and telemetry
// modules. Carved out of agent.ts (the retired universal-bot monolith) so
// the live modules depend on these shapes without pulling in the bot.
//
// `SignupResult` is the terminal outcome of a provision run; `PostVerifyStep`
// is one planner-emitted action in the post-verification navigation loop.

import type { CaptchaKind, CaptchaVariant } from "./browser.js";
import type { FailureStage } from "./failure-stage.js";

export interface SignupResult {
  success: boolean;
  credentials?: {
    api_key?: string;
    username?: string;
    password?: string;
    [key: string]: string | undefined;
  };
  error?: string;
  steps: string[];
  // B1 — the terminal failure-stage label (flakiness taxonomy). Set on the
  // finished result so telemetry + the outcome sidecar share one value.
  // "none" on success; see classifyFailureStage in failure-stage.ts.
  failure_stage?: FailureStage;
  // How many LLM calls this run made. Useful for cost accounting and
  // for catching regressions where a refactor accidentally doubles the
  // round-trips.
  llm_calls?: number;
  // One entry per LLM call, identifying which backend handled it.
  // E.g. ["openrouter:google/gemini-flash-1.5", "openrouter:anthropic/claude-3.5-sonnet"]
  // means the cheap path was used twice and the premium fallback engaged
  // once. Useful for verifying dual-mode is actually saving money in
  // production rather than always landing on the premium fallback.
  llm_backends?: readonly string[];

  // Browser channel actually launched ("chrome", "msedge", or null for
  // bundled Chromium). Surfaced for telemetry: a captcha failure on
  // bundled Chromium is materially different signal from the same
  // failure on real Chrome.
  browser_channel?: string | null;

  // Whether this run's browser egress was routed through the
  // residential proxy (true) or went out direct (false). Lets the
  // CaptchaEvent ledger answer "did the proxy actually run?" — a
  // captcha block behind a residential proxy is a materially
  // different signal from one on a bare datacenter IP.
  proxied?: boolean;

  // Which stealth launcher this run used: "cdp_hardened" when the
  // patchright launcher loaded (BOT_CDP_HARDENED set + patchright
  // present), else "baseline". The CaptchaEvent A/B tag that lets us
  // measure whether isolated-world execution (closing mainWorldExecution
  // + webdriver tells) lowers block rate — see
  // docs/DESIGN-antibot-hardening.md.
  stealth_profile?: "baseline" | "cdp_hardened";

  // Skill provenance: which path produced this result. Legacy field from the
  // universal-bot era. The autonomous replay ENGINE was excised (signin-vault
  // PR1), so the "skill" path is no longer produced in source; the field is
  // retained for wire/registry compatibility and assessed for removal in PR4.
  via?: "bot" | "skill";
  skill_id?: string;
  skill_version?: string;

  // Captcha encountered during the run. Populated only when the agent
  // hit at least one captcha widget — null/undefined otherwise. The
  // MCP tool layer reads this to emit a CaptchaEvent.
  captcha?: {
    kind: CaptchaKind;
    // Finer family classification + whether an image-grid challenge
    // actually rendered (vs a checkbox that passed, or score-only
    // reCAPTCHA). Spike telemetry — feeds CaptchaEvent (T3.2).
    variant: CaptchaVariant;
    challenge_rendered: boolean;
    // The bot's view of what happened. `blocked: true` means the run
    // bailed because the captcha didn't resolve; `blocked: false`
    // means the bot got past it (token populated client-side).
    blocked: boolean;
  };
}

// What to do next after the verification link is clicked. Most services
// land you on a dashboard with the API key visible; some require one or
// two clicks ("create your first project", "skip tour", etc.) before the
// key appears. The post-verification loop asks Claude one of these on
// every round until it sees `done` or runs out of rounds.
export type PostVerifyStep =
  | { kind: "done"; reason: string }
  | { kind: "extract"; reason: string }
  | { kind: "login"; reason: string }
  | { kind: "click"; selector: string; reason: string }
  | { kind: "fill"; selector: string; value: string; reason: string }
  // `select` — pick an option for a dropdown (native <select> OR a
  // custom ARIA combobox: Radix, Headless UI, React Aria, cmdk).
  // When `option_text` is given, the executor matches by visible text
  // (case-insensitive substring); otherwise picks the first real
  // option. Sentry's permissions picker is the canonical combobox
  // case — F11 added combobox support so this step works there.
  | {
      kind: "select";
      selector: string;
      reason: string;
      option_text?: string;
    }
  // `check` — tick a checkbox (a post-OAuth onboarding form's
  // terms-of-service / agreement box). A `click` lands on the box's
  // styled label or its TOS *link* and does not flip the input;
  // browser.check() force-ticks the underlying checkbox.
  | { kind: "check"; selector: string; reason: string }
  // `scroll` — scroll a ToS / agreement modal to the bottom so a
  // gated "Accept" button enables (Railway is the canonical case).
  // `selector` is OPTIONAL: the inventory only carries interactive
  // elements, so the planner usually can't name the scrollable div.
  // When absent the bot auto-detects the largest visible scrollable
  // container; when present it is used verbatim.
  | { kind: "scroll"; selector?: string; reason: string }
  | { kind: "navigate"; url: string; reason: string }
  | { kind: "wait"; seconds: number; reason: string };
