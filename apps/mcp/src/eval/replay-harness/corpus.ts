import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CheckoutSummary } from "../../bot/browser.js";
import type { ColdBaseline, ExpectedEndState, ShoppingTaskRecord } from "./types.js";

const DEFAULT_CORPUS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../corpus/shopping",
);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseEndState(value: unknown, label: string): ExpectedEndState {
  if (!isObject(value) || !Array.isArray(value.line_items)) {
    throw new Error(`${label}: expected_end_state must contain line_items`);
  }
  const lineItems = value.line_items.map((item, index) => {
    if (
      !isObject(item) ||
      typeof item.title_contains !== "string" ||
      !Number.isInteger(item.qty) ||
      (item.qty as number) < 1
    ) {
      throw new Error(`${label}: invalid line_items[${index}]`);
    }
    return { title_contains: item.title_contains, qty: item.qty as number };
  });
  if (!Number.isInteger(value.total_cents) || (value.total_cents as number) < 0) {
    throw new Error(`${label}: total_cents must be a non-negative integer`);
  }
  if (typeof value.reached !== "string" || value.reached.length === 0) {
    throw new Error(`${label}: reached must be a non-empty string`);
  }
  return {
    line_items: lineItems,
    total_cents: value.total_cents as number,
    reached: value.reached,
  };
}

function parseBaseline(value: unknown, label: string): ColdBaseline {
  if (!isObject(value)) throw new Error(`${label}: cold_baseline is required`);
  const endState = parseEndState(value.end_state, `${label}.cold_baseline.end_state`);
  if (
    !isNonNegativeNumber(value.turns) ||
    !isNonNegativeNumber(value.tokens) ||
    !isNonNegativeNumber(value.wall_clock_ms)
  ) {
    throw new Error(`${label}: cold_baseline costs must be non-negative numbers`);
  }
  if (
    !isObject(value.provenance) ||
    value.provenance.source !== "driver" ||
    typeof value.provenance.driver !== "string" ||
    value.provenance.driver.length === 0 ||
    typeof value.provenance.model !== "string" ||
    value.provenance.model.length === 0 ||
    typeof value.provenance.recorded_at !== "string" ||
    Number.isNaN(Date.parse(value.provenance.recorded_at)) ||
    !Number.isInteger(value.provenance.browser_observations) ||
    (value.provenance.browser_observations as number) < 1 ||
    typeof value.provenance.evidence_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.provenance.evidence_sha256) ||
    (value.provenance.capture_policy !== "read-only-playwright-mcp-v2" &&
      value.provenance.capture_policy !== "read-only-playwright-mcp-v3") ||
    (endState.reached === "checkout_review" &&
      value.provenance.capture_policy !== "read-only-playwright-mcp-v3")
  ) {
    throw new Error(`${label}: cold_baseline requires grounded browser provenance`);
  }
  return {
    turns: value.turns,
    tokens: value.tokens,
    wall_clock_ms: value.wall_clock_ms,
    end_state: endState,
    provenance: {
      source: "driver",
      driver: value.provenance.driver,
      model: value.provenance.model,
      recorded_at: value.provenance.recorded_at,
      browser_observations: value.provenance.browser_observations as number,
      evidence_sha256: value.provenance.evidence_sha256,
      capture_policy: value.provenance.capture_policy,
      ...(typeof value.provenance.trace_artifact === "string"
        ? { trace_artifact: value.provenance.trace_artifact }
        : {}),
      ...(typeof value.provenance.checkout_artifact === "string"
        ? { checkout_artifact: value.provenance.checkout_artifact }
        : {}),
    },
  };
}

export function resolveShoppingCorpusDir(): string | null {
  const configured = process.env.REPLAY_EVAL_CORPUS_DIR?.trim();
  if (configured !== undefined && ["", "0", "off", "false"].includes(configured.toLowerCase())) {
    return null;
  }
  const directory = configured ?? DEFAULT_CORPUS_DIR;
  return existsSync(directory) ? directory : null;
}

export function parseTaskRecord(value: unknown, file: string): ShoppingTaskRecord {
  if (!isObject(value)) throw new Error(`${file}: task record must be an object`);
  const requiredStrings = ["task_id", "domain", "entry_url", "har"] as const;
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      throw new Error(`${file}: ${field} must be a non-empty string`);
    }
  }
  if (value.verb !== "purchase") throw new Error(`${file}: v1 supports verb=purchase only`);
  if (value.bucket !== "repeat" && value.bucket !== "novel") {
    throw new Error(`${file}: bucket must be repeat or novel`);
  }
  if (!isObject(value.params)) {
    throw new Error(`${file}: params is required`);
  }
  const params = value.params;
  if (!isObject(params.address)) {
    throw new Error(`${file}: params.address is required`);
  }
  const address = params.address;
  const contact = params.contact;
  if (
    typeof params.product_query !== "string" ||
    typeof params.card_ref !== "string" ||
    typeof address.country !== "string" ||
    typeof address.postal_code !== "string"
  ) {
    throw new Error(`${file}: invalid params`);
  }
  if (
    !isObject(value.capture) ||
    (value.capture.status !== "captured" && value.capture.status !== "skipped")
  ) {
    throw new Error(`${file}: capture status is required`);
  }

  const expectedEndState = parseEndState(value.expected_end_state, file);
  const coldBaseline = parseBaseline(value.cold_baseline, file);
  const task: ShoppingTaskRecord = {
    task_id: value.task_id as string,
    verb: "purchase",
    domain: value.domain as string,
    entry_url: value.entry_url as string,
    params: {
      product_query: params.product_query,
      ...(typeof params.product_variant_id === "string"
        ? { product_variant_id: params.product_variant_id }
        : {}),
      ...(Number.isInteger(params.product_price_cents) &&
      (params.product_price_cents as number) >= 0
        ? { product_price_cents: params.product_price_cents as number }
        : {}),
      address: {
        country: address.country,
        postal_code: address.postal_code,
        ...(typeof address.region === "string" ? { region: address.region } : {}),
        ...(typeof address.line1 === "string" ? { line1: address.line1 } : {}),
        ...(typeof address.city === "string" ? { city: address.city } : {}),
      },
      ...(isObject(contact) &&
      typeof contact.email === "string" &&
      typeof contact.first_name === "string" &&
      typeof contact.last_name === "string" &&
      typeof contact.phone === "string"
        ? {
            contact: {
              email: contact.email,
              first_name: contact.first_name,
              last_name: contact.last_name,
              phone: contact.phone,
            },
          }
        : {}),
      card_ref: params.card_ref,
    },
    expected_end_state: expectedEndState,
    har: value.har as string,
    bucket: value.bucket,
    cold_baseline: coldBaseline,
    capture: {
      status: value.capture.status,
      ...(typeof value.capture.captured_at === "string"
        ? { captured_at: value.capture.captured_at }
        : {}),
      ...(typeof value.capture.skip_reason === "string"
        ? { skip_reason: value.capture.skip_reason }
        : {}),
    },
  };
  const rawBaseline = value.cold_baseline;
  if (
    task.bucket === "repeat" &&
    task.capture.status === "captured" &&
    (!isObject(rawBaseline) ||
      !isObject(rawBaseline.provenance) ||
      typeof rawBaseline.provenance.trace_artifact !== "string" ||
      typeof rawBaseline.provenance.checkout_artifact !== "string")
  ) {
    throw new Error(`${file}: captured repeat requires real trace_artifact and checkout_artifact`);
  }
  if (task.capture.status === "captured" && !existsSync(resolveHarPath(task, dirname(file)))) {
    throw new Error(`${file}: captured HAR is missing (${task.har})`);
  }
  return task;
}

export function loadShoppingCorpus(directory = resolveShoppingCorpusDir()): ShoppingTaskRecord[] {
  if (directory === null) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== "capture-log.json")
    .sort()
    .map((name) => {
      const file = join(directory, name);
      return parseTaskRecord(JSON.parse(readFileSync(file, "utf8")) as unknown, file);
    });
}

export function resolveHarPath(task: ShoppingTaskRecord, corpusDir: string): string {
  return isAbsolute(task.har) ? task.har : join(corpusDir, task.har);
}

export function endStatesMatch(actual: ExpectedEndState, expected: ExpectedEndState): boolean {
  if (actual.total_cents !== expected.total_cents || actual.reached !== expected.reached)
    return false;
  if (actual.line_items.length !== expected.line_items.length) return false;
  return expected.line_items.every((wanted) =>
    actual.line_items.some(
      (actualItem) =>
        actualItem.qty === wanted.qty &&
        actualItem.title_contains.toLowerCase().includes(wanted.title_contains.toLowerCase()),
    ),
  );
}

export function parseCheckoutArtifact(value: unknown, task: ShoppingTaskRecord): CheckoutSummary {
  if (
    !isObject(value) ||
    typeof value.merchant !== "string" ||
    value.merchant.length === 0 ||
    typeof value.checkout_origin !== "string" ||
    !Number.isInteger(value.amount_cents) ||
    (value.amount_cents as number) < 0 ||
    typeof value.currency !== "string" ||
    value.currency.length === 0
  ) {
    throw new Error(`${task.task_id}: invalid checkout artifact`);
  }
  let checkoutOrigin: URL;
  let entryOrigin: URL;
  try {
    checkoutOrigin = new URL(value.checkout_origin);
    entryOrigin = new URL(task.entry_url);
  } catch {
    throw new Error(`${task.task_id}: checkout artifact has an invalid origin`);
  }
  if (checkoutOrigin.protocol !== "https:" || checkoutOrigin.origin !== entryOrigin.origin) {
    throw new Error(`${task.task_id}: checkout artifact origin does not match the task`);
  }
  if (value.amount_cents !== task.expected_end_state.total_cents) {
    throw new Error(
      `${task.task_id}: checkout artifact total ${String(value.amount_cents)} does not match settled expected total ${task.expected_end_state.total_cents}`,
    );
  }
  return {
    merchant: value.merchant,
    checkout_origin: checkoutOrigin.origin,
    amount_cents: value.amount_cents as number,
    currency: value.currency,
  };
}
