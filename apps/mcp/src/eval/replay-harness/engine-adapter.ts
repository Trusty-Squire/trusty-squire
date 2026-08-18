import { performance } from "node:perf_hooks";
import type { Page } from "playwright";
import {
  BrowserController,
  type CheckoutReviewSummary,
  type CheckoutSummary,
} from "../../bot/browser.js";
import { fillTemplate, recipeEntryUrl, type OperatorRecipe } from "../../bot/operator-recipe.js";
import { checkoutSummaryMatches } from "../../bot/pay-operator.js";
import {
  act,
  finishProvisionSession,
  observe,
  replayOperatorRecipe,
  startHarnessProvisionSession,
  type Observation,
  type ProvisionAction,
} from "../../bot/provision-session.js";

export interface EngineReplayMeasurement {
  wall_clock_ms: number;
  total_steps: number;
  fallbacks: number;
  status:
    | "complete"
    | "fallback_required"
    | "human_required"
    | "leg_fallback_required"
    | "domain_lock_violation"
    | "unavailable";
  reason?: string;
  /** Exact production money-field guard failure, retained for eval diagnosis. */
  field?: string;
  turns: number;
  tokens: number;
}

export function combineReplayMeasurements(
  left: EngineReplayMeasurement,
  right: EngineReplayMeasurement,
): Pick<
  EngineReplayMeasurement,
  "wall_clock_ms" | "total_steps" | "fallbacks" | "turns" | "tokens"
> {
  return {
    wall_clock_ms: left.wall_clock_ms + right.wall_clock_ms,
    total_steps: left.total_steps + right.total_steps,
    fallbacks: left.fallbacks + right.fallbacks,
    turns: left.turns + right.turns,
    tokens: left.tokens + right.tokens,
  };
}

const FINAL_PAYMENT_CONTROL =
  /pay\s*now|place\s*(?:the\s*)?order|complete\s*order|submit\s*order|buy\s*now|confirm\s*(?:order|purchase)|purchase\s*now/i;

export function harnessActionBlockReason(
  action: ProvisionAction,
  observation?: Observation,
): string | null {
  if (action.kind === "press") {
    return /^(?:Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/.test(
      action.key,
    )
      ? null
      : "replay evaluation rejects submit-capable key presses";
  }
  if (action.kind !== "click" && action.kind !== "js_click" && action.kind !== "oauth_click") {
    return null;
  }
  if (!action.target.startsWith("@e:")) {
    return "replay evaluation requires a freshly resolved live ref for activation";
  }
  const target = observation?.elements?.find((element) => element.ref === action.target);
  if (target === undefined) {
    return "replay evaluation activation target did not resolve in the current live inventory";
  }
  const descriptor = `${target.label} ${target.role ?? ""} ${target.type ?? ""}`;
  if (
    FINAL_PAYMENT_CONTROL.test(descriptor) ||
    (target.type?.toLowerCase() === "submit" &&
      /^(?:submit|finalize\s*order)$/i.test(target.label.trim()) &&
      /\bpayment\b|\bpay\s*now\b|\bfinalize\s*order\b/i.test(observation?.text ?? ""))
  ) {
    return "replay evaluation rejects final payment controls";
  }
  return null;
}

async function assertSafeHarnessAction(sessionId: string, action: ProvisionAction): Promise<void> {
  const needsInventory =
    action.kind === "click" || action.kind === "js_click" || action.kind === "oauth_click";
  const observation = needsInventory ? await observe(sessionId, "full") : undefined;
  const reason = harnessActionBlockReason(action, observation);
  if (reason !== null) throw new Error(reason);
}

export interface FallbackRescueResult {
  action: ProvisionAction;
  turns: number;
  tokens: number;
}

/**
 * The rescue model is an untrusted wire-format producer.  Accept the one
 * wrapper shape it has emitted for a live ref, but make every action satisfy
 * the production ProvisionAction transport contract before it can reach act.
 * In particular, no object/undefined target may reach resolveTarget(), whose
 * contract deliberately takes a string.
 */
export function parseFallbackAction(value: unknown): ProvisionAction {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fallback rescue returned a non-object action");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.kind !== "string") throw new Error("fallback rescue action has no kind");
  const target = (): string => {
    if (typeof raw.target === "string") return raw.target;
    if (
      raw.target !== null &&
      typeof raw.target === "object" &&
      !Array.isArray(raw.target) &&
      Object.keys(raw.target).length === 1 &&
      typeof (raw.target as { ref?: unknown }).ref === "string"
    ) {
      // This is a lossless normalization of the model's emitted live-ref
      // wrapper, not a locator synthesis. Clicks still require a fresh full
      // inventory resolution in assertSafeFallbackAction below.
      return (raw.target as { ref: string }).ref;
    }
    throw new Error("fallback rescue target must be a string or { ref: string }");
  };
  switch (raw.kind) {
    case "click":
    case "js_click":
      return { kind: raw.kind, target: target() };
    case "type":
    case "select":
      if (typeof raw.text !== "string") {
        throw new Error(`fallback rescue ${raw.kind} action has no string text`);
      }
      return { kind: raw.kind, target: target(), text: raw.text };
    case "set_phone_country":
      if (typeof raw.country !== "string") {
        throw new Error("fallback rescue set_phone_country action has no string country");
      }
      return { kind: "set_phone_country", country: raw.country };
    case "goto":
      if (typeof raw.url !== "string")
        throw new Error("fallback rescue goto action has no string url");
      return { kind: "goto", url: raw.url };
    case "press":
      if (typeof raw.key !== "string")
        throw new Error("fallback rescue press action has no string key");
      return { kind: "press", key: raw.key };
    case "scroll":
      if (
        raw.direction !== undefined &&
        raw.direction !== "down" &&
        raw.direction !== "up" &&
        raw.direction !== "bottom" &&
        raw.direction !== "top"
      ) {
        throw new Error("fallback rescue scroll action has an invalid direction");
      }
      return {
        kind: "scroll",
        ...(raw.direction === undefined ? {} : { direction: raw.direction }),
      };
    default:
      throw new Error(`fallback rescue action kind is not allowed: ${raw.kind}`);
  }
}

export type FallbackRescue = (input: {
  observation: Observation;
  step_index: number;
  reason: string;
  action: OperatorRecipe["trace"][number]["action"];
  bindings: Readonly<Record<string, string>>;
}) => Promise<FallbackRescueResult>;

/**
 * Execute the shipping replay path against a page owned by the harness. It
 * reaches the same production resolver, action executor, provenance checks,
 * and money-field attestations as operate_recipe_run.
 */
export async function replayRecipeOnHarnessPage(args: {
  page: Page;
  service_url: string;
  recipe: OperatorRecipe;
  bindings: Readonly<Record<string, string>>;
  before_step?: (input: {
    step_index: number;
    action: OperatorRecipe["trace"][number]["action"];
  }) => Promise<void> | void;
  rescue: FallbackRescue;
}): Promise<EngineReplayMeasurement> {
  const controller = BrowserController.fromHarnessPage(args.page);
  const began = performance.now();
  const entry = recipeEntryUrl(args.recipe, args.service_url);
  if (entry === null) throw new Error(`operator recipe ${args.recipe.name} has no replay entry`);
  const filledEntry = fillTemplate(entry, args.bindings as Record<string, string>);
  if (filledEntry.missing.length > 0) {
    throw new Error(`operator recipe ${args.recipe.name} needs ${filledEntry.missing.join(", ")}`);
  }
  const started = await startHarnessProvisionSession({
    browser: controller,
    serviceUrl: filledEntry.url,
    extraAllowedHosts: args.recipe.allowed_hosts,
  });
  try {
    let nextIndex = 0;
    let fallbacks = 0;
    let turns = 0;
    let tokens = 0;
    while (true) {
      const replay = await replayOperatorRecipe(
        started.session_id,
        args.recipe,
        args.bindings,
        nextIndex,
        {
          beforeStep: async (input) => {
            if (input.action.kind === "operate_pay") {
              throw new Error("replay evaluation refuses to enter payment ceremony");
            }
            await args.before_step?.(input);
          },
          beforeAction: async ({ action }) =>
            await assertSafeHarnessAction(started.session_id, action),
        },
      );
      if (replay.status !== "fallback_required") {
        return {
          wall_clock_ms: Math.round(performance.now() - began),
          total_steps: args.recipe.trace.length,
          fallbacks,
          status: replay.status,
          turns,
          tokens,
          ...(replay.status === "complete" || replay.status === "domain_lock_violation"
            ? {}
            : { reason: replay.reason }),
          ...(replay.status === "domain_lock_violation"
            ? { reason: `"${replay.host}" is outside recipe domain "${replay.recipe_domain}"` }
            : {}),
          ...(replay.status === "human_required" ? { field: replay.field } : {}),
        };
      }
      if (replay.step.action.kind === "operate_pay") {
        throw new Error("replay evaluation refuses to enter payment ceremony");
      }
      let rescued: FallbackRescueResult;
      try {
        rescued = await args.rescue({
          observation: replay.observation,
          step_index: replay.step_index,
          reason: replay.reason,
          action: replay.step.action,
          bindings: args.bindings,
        });
        await assertSafeHarnessAction(started.session_id, rescued.action);
      } catch (error) {
        return {
          wall_clock_ms: Math.round(performance.now() - began),
          total_steps: args.recipe.trace.length,
          fallbacks: fallbacks + 1,
          status: "unavailable",
          turns,
          tokens,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      const value = replay.step.action.value;
      const repair =
        value !== undefined &&
        typeof value !== "string" &&
        (rescued.action.kind === "type" ||
          rescued.action.kind === "select" ||
          rescued.action.kind === "set_phone_country")
          ? { ...rescued.action, replayRepair: { stepIndex: replay.step_index, hole: value.hole } }
          : rescued.action;
      await act(started.session_id, repair, "full");
      fallbacks += 1;
      turns += rescued.turns;
      tokens += rescued.tokens;
      nextIndex = replay.next_index;
    }
  } finally {
    await finishProvisionSession(started.session_id).catch(() => undefined);
  }
}

/**
 * Reuses the payment-path comparison at checkout review without creating an
 * approval, passkey request, card lookup, or submission.
 */
export async function verifyCheckoutReview(
  page: Page,
  expected: CheckoutSummary,
): Promise<{ guard_action: "clean" | "abort"; observed?: CheckoutReviewSummary }> {
  const controller = BrowserController.fromHarnessPage(page);
  try {
    const observed = await controller.readSettledCheckoutReviewSummary(expected.currency);
    return {
      guard_action: checkoutSummaryMatches(expected, observed) ? "clean" : "abort",
      ...(observed === undefined ? {} : { observed }),
    };
  } finally {
    await controller.close();
  }
}
