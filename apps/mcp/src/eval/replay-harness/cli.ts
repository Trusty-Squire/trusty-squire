/** Run the frozen-storefront/live-checkout replay evaluation against the checked-in corpus. */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium, type BrowserContext, type Page } from "playwright";
import { type CheckoutReviewSummary, type CheckoutSummary } from "../../bot/browser.js";
import {
  OperatorRecipeSchema,
  readRecipeForTask,
  writeRecipe,
  type OperatorRecipe,
} from "../../bot/operator-recipe.js";
import {
  endStatesMatch,
  loadShoppingCorpus,
  parseCheckoutArtifact,
  resolveHarPath,
  resolveShoppingCorpusDir,
} from "./corpus.js";
import {
  combineReplayMeasurements,
  parseFallbackAction,
  replayRecipeOnHarnessPage,
  verifyCheckoutReview,
} from "./engine-adapter.js";
import type { FallbackRescue } from "./engine-adapter.js";
import type { HarFile } from "./har-mutate.js";
import { buildHarnessReport } from "./metrics.js";
import { renderReportJson, renderReportMarkdown } from "./reporter.js";
import { runDriftBattery, unavailableDriftBattery } from "./runner.js";
import { whitejadeCartPermalink } from "./har-substrate.js";
import { splitTwoContextReplay } from "./two-context-handoff.js";
import type {
  ExpectedEndState,
  HarnessReport,
  ShoppingTaskRecord,
  TaskObservation,
} from "./types.js";

const workDir = resolve(process.cwd(), ".replay-eval");
const outputDir = resolve(process.cwd(), "replay-eval-output");
const corpusDir = resolveShoppingCorpusDir();

interface PreparedRecipe {
  recipe: OperatorRecipe;
  checkout: CheckoutSummary;
}

interface WarmReplayResult {
  observation: TaskObservation;
  guard_action: "clean" | "fallback" | "abort";
  actual: ExpectedEndState;
  checkout_verification?: {
    guard_action: "clean" | "abort";
    observed_end_state?: ExpectedEndState;
  };
  /** An unavailable replay is an execution failure, never a payment escape. */
  infrastructure_failure?: string;
}

type RepeatOutcome = NonNullable<HarnessReport["evaluation"]>["repeat_outcomes"][number];

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

function divergentFields(actual: ExpectedEndState, expected: ExpectedEndState): string[] {
  const fields: string[] = [];
  if (actual.total_cents !== expected.total_cents)
    fields.push(`total_cents observed ${actual.total_cents}, expected ${expected.total_cents}`);
  if (actual.reached !== expected.reached)
    fields.push(`reached observed ${actual.reached}, expected ${expected.reached}`);
  if (JSON.stringify(actual.line_items) !== JSON.stringify(expected.line_items))
    fields.push(
      `line_items observed ${JSON.stringify(actual.line_items)}, expected ${JSON.stringify(expected.line_items)}`,
    );
  return fields;
}

function requireCorpus(): string {
  if (corpusDir === null) throw new Error("replay corpus is disabled or missing");
  return corpusDir;
}

function checkoutEndState(page: Page, checkout: CheckoutReviewSummary): ExpectedEndState {
  return {
    line_items: checkout.line_items.map((item) => ({
      title_contains: item.title,
      qty: item.quantity,
    })),
    total_cents: checkout.amount_cents,
    reached: new URL(page.url()).pathname.startsWith("/checkouts/")
      ? "checkout_review"
      : "not_checkout",
  };
}

function artifactPath(
  task: ShoppingTaskRecord,
  field: "trace_artifact" | "checkout_artifact",
): string {
  const artifact = task.cold_baseline.provenance[field];
  if (artifact === undefined) throw new Error(`${task.task_id}: missing ${field}`);
  return resolve(requireCorpus(), artifact);
}

async function seedRecordedRecipe(task: ShoppingTaskRecord): Promise<void> {
  const recipe = OperatorRecipeSchema.parse(
    JSON.parse(readFileSync(artifactPath(task, "trace_artifact"), "utf8")),
  );
  await writeRecipe(recipe);
}

function assertRealTraceArtifact(task: ShoppingTaskRecord): void {
  // Every repeat record must retain its own constrained-capture evidence even
  // though production storage intentionally has one purchase--whitejade key.
  OperatorRecipeSchema.parse(
    JSON.parse(readFileSync(artifactPath(task, "trace_artifact"), "utf8")),
  );
  parseCheckoutArtifact(
    JSON.parse(readFileSync(artifactPath(task, "checkout_artifact"), "utf8")) as unknown,
    task,
  );
}

async function lookupPreparedRecipe(task: ShoppingTaskRecord): Promise<PreparedRecipe | null> {
  try {
    return {
      recipe: await readRecipeForTask(task.verb, task.entry_url),
      checkout: parseCheckoutArtifact(
        JSON.parse(readFileSync(artifactPath(task, "checkout_artifact"), "utf8")) as unknown,
        task,
      ),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function productionRecipeHit(task: ShoppingTaskRecord): Promise<boolean> {
  try {
    await readRecipeForTask(task.verb, task.entry_url);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function taskBindings(task: ShoppingTaskRecord): Record<string, string> {
  const { address, contact } = task.params;
  if (contact === undefined || address.line1 === undefined || address.city === undefined) {
    throw new Error(
      `${task.task_id}: repeat checkout replay requires captured synthetic contact and street params`,
    );
  }
  return {
    product_query: task.params.product_query,
    quantity: "1",
    "address.country": "United States",
    "address.postal_code": address.postal_code,
    // The captured recipe uses this one hole for city text and the state option label.
    "address.region": address.city,
    "address.line1": address.line1,
    "address.city": address.city,
    "contact.email": contact.email,
    "contact.name": `${contact.first_name} ${contact.last_name}`,
    "contact.first_name": contact.first_name,
    "contact.last_name": contact.last_name,
    "contact.phone": contact.phone,
  };
}

const rescueFallback: FallbackRescue = async (input) => {
  const model = process.env.REPLAY_EVAL_WARM_MODEL ?? "gpt-5.6-sol";
  const prompt = [
    "Return only JSON for one safe browser repair action.",
    "Allowed kinds: click, js_click, type, select, set_phone_country, goto, press, scroll.",
    'For every click, js_click, type, or select, set target to the literal live ref string: {"target":"@e:…"}. Do not wrap it in an object.',
    "Never enter payment, submit an order, request a card, or click a final payment control.",
    `Missed step: ${JSON.stringify({ step_index: input.step_index, reason: input.reason, action: input.action })}`,
    `Bindings: ${JSON.stringify(input.bindings)}`,
    `Live observation: ${JSON.stringify(input.observation)}`,
    "Use a live element ref from the observation for target actions.",
  ].join("\n");
  const child = spawn(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--json",
      "--sandbox",
      "read-only",
      "--disable",
      "shell_tool",
      "--disable",
      "apps",
      "--disable",
      "skill_search",
      "--disable",
      "multi_agent",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "-c",
      'approval_policy="never"',
      "-m",
      model,
      "-",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(prompt);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", resolveExit);
  });
  if (exitCode !== 0) throw new Error(`fallback rescue exited ${exitCode}: ${stderr.trim()}`);
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type?: string;
          item?: { type?: string; text?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        },
    );
  const raw = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text)
    .filter((text): text is string => text !== undefined)
    .at(-1);
  if (raw === undefined) throw new Error("fallback rescue returned no action");
  const rawAction = JSON.parse(
    raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""),
  ) as unknown;
  const action = parseFallbackAction(rawAction);
  const usage = events.find((event) => event.type === "turn.completed")?.usage;
  if (
    usage === undefined ||
    !Number.isFinite(usage.input_tokens) ||
    !Number.isFinite(usage.output_tokens)
  ) {
    throw new Error("fallback rescue completed without measured token usage");
  }
  const inputTokens = usage.input_tokens as number;
  const outputTokens = usage.output_tokens as number;
  return {
    action,
    turns: 1,
    tokens: inputTokens + outputTokens,
  };
};

async function warmReplay(
  task: ShoppingTaskRecord,
  prepared: PreparedRecipe,
  harPath: string,
  repeatOutcomes?: Map<string, RepeatOutcome>,
  checkoutMutation?: "change-price",
): Promise<WarmReplayResult> {
  const warmStartedAt = performance.now();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  let frozen: BrowserContext | undefined;
  let context: BrowserContext | undefined;
  try {
    // The storefront stays frozen under native HAR routing, including its
    // actions.  Checkout is not unfrozen in-place: a fresh JS-enabled context
    // enters a cart permalink carrying the task's variant selection.
    frozen = await browser.newContext({ javaScriptEnabled: true });
    const frozenPage = await frozen.newPage();
    await frozenPage.routeFromHAR(harPath, { update: false, notFound: "abort" });
    const handoff = splitTwoContextReplay(prepared.recipe);
    const storefront = await replayRecipeOnHarnessPage({
      page: frozenPage,
      service_url: task.entry_url,
      recipe: handoff.storefront,
      bindings: taskBindings(task),
      rescue: rescueFallback,
    });
    await frozen.close();
    frozen = undefined;
    if (storefront.status === "unavailable") {
      const actual = { line_items: [], total_cents: -1, reached: "unobserved" };
      if (repeatOutcomes !== undefined) {
        repeatOutcomes.set(task.task_id, {
          task_id: task.task_id,
          expected_end_state: task.expected_end_state,
          observed_end_state: actual,
          divergent_fields: divergentFields(actual, task.expected_end_state),
          fallbacks: storefront.fallbacks,
          verdict_class: "infrastructure",
          assessment: `frozen storefront replay unavailable (not a money escape): ${storefront.reason ?? "unknown reason"}`,
        });
      }
      return {
        observation: {
          task_id: task.task_id,
          bucket: task.bucket,
          cold: task.cold_baseline,
          cold_recording: {
            task_id: task.task_id,
            ...task.cold_baseline,
            end_state_matches: endStatesMatch(
              task.cold_baseline.end_state,
              task.expected_end_state,
            ),
          },
          recipe_applied: true,
          end_state_matches: false,
          fallbacks: storefront.fallbacks,
          total_steps: prepared.recipe.trace.length,
          warm_unavailable_reason: storefront.reason ?? "frozen storefront replay unavailable",
        },
        guard_action: "fallback",
        actual,
        infrastructure_failure: storefront.reason ?? "frozen storefront replay unavailable",
      };
    }
    context = await browser.newContext({ javaScriptEnabled: true });
    if (checkoutMutation === "change-price") {
      // Price drift must cross the live checkout boundary.  This mutates the
      // rendered checkout total before the production verifier reads it; no
      // synthetic observed end state or oracle is supplied by the harness.
      await context.addInitScript(
        ({ expected, changed }) => {
          const replaceDisplayedTotal = () => {
            if (document.body === null) return false;
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
              if (node.textContent?.includes(expected)) {
                node.textContent = node.textContent.replace(expected, changed);
                return true;
              }
            }
            return false;
          };
          if (!replaceDisplayedTotal()) {
            new MutationObserver(() => replaceDisplayedTotal()).observe(document, {
              childList: true,
              subtree: true,
              characterData: true,
            });
          }
        },
        {
          expected: `$${(task.expected_end_state.total_cents / 100).toFixed(2)}`,
          changed: `$${((task.expected_end_state.total_cents + 100) / 100).toFixed(2)}`,
        },
      );
    }
    const page = await context.newPage();
    const measurement = await replayRecipeOnHarnessPage({
      page,
      service_url: whitejadeCartPermalink(task),
      recipe: handoff.checkout,
      bindings: taskBindings(task),
      rescue: rescueFallback,
    });
    const review = await verifyCheckoutReview(page, prepared.checkout);
    const warmWallClockMs = Math.round(performance.now() - warmStartedAt);
    const combined = combineReplayMeasurements(storefront, measurement);
    const observed = review.observed;
    const actual =
      observed === undefined
        ? { line_items: [], total_cents: -1, reached: "unobserved" }
        : checkoutEndState(page, observed);
    const endStateMatches =
      measurement.status === "complete" &&
      review.guard_action === "clean" &&
      endStatesMatch(actual, task.expected_end_state);
    const observation: TaskObservation = {
      task_id: task.task_id,
      bucket: task.bucket,
      cold: {
        turns: task.cold_baseline.turns,
        tokens: task.cold_baseline.tokens,
        wall_clock_ms: task.cold_baseline.wall_clock_ms,
      },
      cold_recording: {
        task_id: task.task_id,
        ...task.cold_baseline,
        end_state_matches: endStatesMatch(task.cold_baseline.end_state, task.expected_end_state),
      },
      recipe_applied: true,
      ...(measurement.status === "unavailable"
        ? {}
        : {
            warm: {
              turns: combined.turns,
              tokens: combined.tokens,
              wall_clock_ms: warmWallClockMs,
            },
          }),
      end_state_matches: endStateMatches,
      fallbacks: combined.fallbacks,
      total_steps: combined.total_steps,
      ...(measurement.status === "unavailable"
        ? { warm_unavailable_reason: measurement.reason ?? "fallback measurement unavailable" }
        : {}),
    };
    const infrastructureFailure =
      measurement.status === "unavailable"
        ? (measurement.reason ?? "fallback measurement unavailable")
        : undefined;
    if (repeatOutcomes !== undefined) {
      const divergent = divergentFields(actual, task.expected_end_state);
      const escaped =
        !endStateMatches &&
        measurement.status === "complete" &&
        measurement.fallbacks === 0 &&
        review.guard_action === "clean";
      repeatOutcomes.set(task.task_id, {
        task_id: task.task_id,
        expected_end_state: task.expected_end_state,
        observed_end_state: actual,
        divergent_fields: divergent,
        fallbacks: combined.fallbacks,
        verdict_class:
          infrastructureFailure !== undefined
            ? "infrastructure"
            : escaped
              ? "escaped_wrong_end_state"
              : measurement.status !== "complete" || review.guard_action === "abort"
                ? "guarded_abort"
                : storefront.fallbacks + measurement.fallbacks > 0
                  ? "fallback_cost"
                  : "clean_replay",
        ...(infrastructureFailure !== undefined
          ? { assessment: `infrastructure failure (not a money escape): ${infrastructureFailure}` }
          : measurement.status !== "complete"
            ? {
                assessment:
                  `production replay guard stopped before completion (${measurement.status}: ${measurement.reason ?? "no reason"}` +
                  `${measurement.field === undefined ? "" : ` for ${measurement.field}`}); ` +
                  (observed === undefined
                    ? "the post-stop checkout review did not yield a settled observation"
                    : "the settled checkout review observation is retained for diagnosis"),
              }
            : escaped
              ? {
                  assessment:
                    "systematic early-read/termination defect: replay ended before the live checkout review state was stably observed and verified against the evidence-hashed expectation",
                }
              : {}),
      });
    }
    return {
      observation,
      guard_action:
        measurement.status === "human_required" || review.guard_action === "abort"
          ? "abort"
          : storefront.fallbacks + measurement.fallbacks > 0
            ? "fallback"
            : "clean",
      actual,
      checkout_verification: {
        guard_action: review.guard_action,
        ...(observed === undefined ? {} : { observed_end_state: actual }),
      },
      ...(infrastructureFailure === undefined
        ? {}
        : { infrastructure_failure: infrastructureFailure }),
    };
  } finally {
    await context?.close().catch(() => undefined);
    await frozen?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const corpus = requireCorpus();
  const tasks = loadShoppingCorpus(corpus);
  const repeats = tasks.filter((task) => task.bucket === "repeat");
  const novelties = tasks.filter((task) => task.bucket === "novel");
  if (repeats.length !== 4 || novelties.length !== 5)
    throw new Error("expected 4 repeat and 5 novel corpus tasks");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  process.env.TRUSTY_SQUIRE_OPERATOR_RECIPE_DIR = resolve(workDir, "recipes");

  const captureFailures = new Map<string, string>();
  for (const task of repeats) {
    try {
      assertRealTraceArtifact(task);
    } catch (error) {
      captureFailures.set(task.task_id, error instanceof Error ? error.message : String(error));
    }
  }
  const successfulRepeats = repeats.filter((task) => !captureFailures.has(task.task_id));
  // Seed exactly one genuine native recipe under the production key. Runtime
  // service_url / hole binding selects each product; no task-specific side map
  // may masquerade as a keyed cache.
  const canonical = successfulRepeats[0];
  if (canonical !== undefined) await seedRecordedRecipe(canonical);

  const observations: TaskObservation[] = [];
  const repeatOutcomes = new Map<string, RepeatOutcome>();
  const controlResults = new Map<string, WarmReplayResult>();
  for (const task of repeats) {
    const failure = captureFailures.get(task.task_id);
    if (failure === undefined) continue;
    const reason = `capture artifact unavailable: ${failure}`;
    const actual = { line_items: [], total_cents: -1, reached: "unobserved" };
    observations.push({
      task_id: task.task_id,
      bucket: task.bucket,
      cold: {
        turns: task.cold_baseline.turns,
        tokens: task.cold_baseline.tokens,
        wall_clock_ms: task.cold_baseline.wall_clock_ms,
      },
      cold_recording: {
        task_id: task.task_id,
        ...task.cold_baseline,
        end_state_matches: endStatesMatch(task.cold_baseline.end_state, task.expected_end_state),
      },
      recipe_applied: false,
      end_state_matches: false,
      fallbacks: 0,
      total_steps: 0,
      warm_unavailable_reason: reason,
    });
    repeatOutcomes.set(task.task_id, {
      task_id: task.task_id,
      expected_end_state: task.expected_end_state,
      observed_end_state: actual,
      divergent_fields: divergentFields(actual, task.expected_end_state),
      fallbacks: 0,
      verdict_class: "infrastructure",
      assessment: `${reason} (not a money escape)`,
    });
  }
  for (const task of successfulRepeats) {
    const prepared = await lookupPreparedRecipe(task);
    if (prepared === null) throw new Error(`${task.task_id}: production recipe lookup missed`);
    try {
      const result = await warmReplay(task, prepared, resolveHarPath(task, corpus), repeatOutcomes);
      controlResults.set(task.task_id, result);
      observations.push(result.observation);
    } catch (error) {
      const actual = { line_items: [], total_cents: -1, reached: "unobserved" };
      observations.push({
        task_id: task.task_id,
        bucket: task.bucket,
        cold: {
          turns: task.cold_baseline.turns,
          tokens: task.cold_baseline.tokens,
          wall_clock_ms: task.cold_baseline.wall_clock_ms,
        },
        cold_recording: {
          task_id: task.task_id,
          ...task.cold_baseline,
          end_state_matches: endStatesMatch(
            task.cold_baseline.end_state,
            task.expected_end_state,
          ),
        },
        recipe_applied: true,
        end_state_matches: false,
        fallbacks: 0,
        total_steps: prepared.recipe.trace.length,
        warm_unavailable_reason: error instanceof Error ? error.message : String(error),
      });
      repeatOutcomes.set(task.task_id, {
        task_id: task.task_id,
        expected_end_state: task.expected_end_state,
        observed_end_state: actual,
        divergent_fields: divergentFields(actual, task.expected_end_state),
        fallbacks: 0,
        verdict_class: "infrastructure",
        assessment: `infrastructure failure (not a money escape): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  for (const task of novelties) {
    const recipeApplied = await productionRecipeHit(task);
    observations.push({
      task_id: task.task_id,
      bucket: task.bucket,
      cold: {
        turns: task.cold_baseline.turns,
        tokens: task.cold_baseline.tokens,
        wall_clock_ms: task.cold_baseline.wall_clock_ms,
      },
      cold_recording: {
        task_id: task.task_id,
        ...task.cold_baseline,
        end_state_matches: endStatesMatch(task.cold_baseline.end_state, task.expected_end_state),
      },
      recipe_applied: recipeApplied,
      end_state_matches: endStatesMatch(task.cold_baseline.end_state, task.expected_end_state),
      fallbacks: 0,
      total_steps: 0,
    });
  }

  const unavailableDrift = repeats.flatMap((task) => {
    const failure = captureFailures.get(task.task_id);
    return failure === undefined
      ? []
      : unavailableDriftBattery(task, `capture artifact unavailable: ${failure}`);
  });
  const measuredDrift = await runDriftBattery(
    successfulRepeats,
    (task) => JSON.parse(readFileSync(resolveHarPath(task, corpus), "utf8")) as HarFile,
    async ({ task, mutation, har }) => {
      const prepared = await lookupPreparedRecipe(task);
      if (prepared === null) throw new Error(`${task.task_id}: production recipe lookup missed`);
      const temporaryHar = resolve(workDir, `${task.task_id}-${mutation}.har`);
      writeFileSync(temporaryHar, JSON.stringify(har));
      let result: WarmReplayResult;
      try {
        result = await warmReplay(
          task,
          prepared,
          temporaryHar,
          undefined,
          mutation === "change-price" ? mutation : undefined,
        );
      } catch (error) {
        return {
          guard_action: "fallback",
          end_state: { line_items: [], total_cents: -1, reached: "unobserved" },
          infrastructure_failure: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        guard_action: result.guard_action,
        ...(mutation === "change-price"
          ? {
              ...(result.checkout_verification === undefined
                ? {}
                : { total_verify_oracle: result.checkout_verification.guard_action }),
              price_guard_causal: (() => {
                const control = controlResults.get(task.task_id)?.checkout_verification;
                const controlObserved = control?.observed_end_state;
                const mutatedObserved = result.checkout_verification?.observed_end_state;
                return (
                  control?.guard_action === "clean" &&
                  controlObserved !== undefined &&
                  endStatesMatch(controlObserved, task.expected_end_state) &&
                  result.checkout_verification?.guard_action === "abort" &&
                  mutatedObserved !== undefined &&
                  mutatedObserved.total_cents !== controlObserved.total_cents
                );
              })(),
            }
          : {}),
        end_state: result.actual,
        ...(result.infrastructure_failure === undefined
          ? {}
          : { infrastructure_failure: result.infrastructure_failure }),
      };
    },
  );
  const drift = [...unavailableDrift, ...measuredDrift];
  const bucketMedian = (bucket: "repeat" | "novel") => {
    const samples = tasks
      .filter((task) => task.bucket === bucket)
      .map((task) => task.cold_baseline);
    return {
      turns: median(samples.map((sample) => sample.turns)),
      tokens: median(samples.map((sample) => sample.tokens)),
      wall_clock_ms: median(samples.map((sample) => sample.wall_clock_ms)),
    };
  };
  const report = buildHarnessReport(observations, drift, {
    mode: "replay-eval",
    evaluation: {
      cold_baseline_by_bucket: { repeat: bucketMedian("repeat"), novel: bucketMedian("novel") },
      capture_failures: [...captureFailures].map(([taskId, failure]) => `${taskId}: ${failure}`),
      repeat_outcomes: repeats.map((task) => {
        const outcome = repeatOutcomes.get(task.task_id);
        if (outcome === undefined) throw new Error(`${task.task_id}: missing warm outcome detail`);
        return outcome;
      }),
    },
  });
  const appendix = [
    "",
    "## Execution appendix",
    "",
    "Cold costs are the checked-in evidence-hashed 2026-08-05 driver baselines; they were read, not re-recorded.",
    "Trace capture corroboration (not used in speedup math):",
    ...(captureFailures.size === 0
      ? ["All repeat trace captures were available."]
      : [...captureFailures].map(
          ([taskId, failure]) => `- Capture failure: ${taskId}: ${failure}`,
        )),
    "Checkout review verification reused the pre-payment shipping comparison; no approval, passkey, card field, or final pay control was invoked.",
  ].join("\n");
  writeFileSync(resolve(outputDir, "report.json"), renderReportJson(report));
  writeFileSync(resolve(outputDir, "report.md"), `${renderReportMarkdown(report)}${appendix}\n`);
  process.stdout.write(
    `${resolve(outputDir, "report.json")}\n${resolve(outputDir, "report.md")}\n`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
