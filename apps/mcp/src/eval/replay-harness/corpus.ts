import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  if (
    !isNonNegativeNumber(value.turns) ||
    !isNonNegativeNumber(value.tokens) ||
    !isNonNegativeNumber(value.wall_clock_ms)
  ) {
    throw new Error(`${label}: cold_baseline costs must be non-negative numbers`);
  }
  return {
    turns: value.turns,
    tokens: value.tokens,
    wall_clock_ms: value.wall_clock_ms,
    end_state: parseEndState(value.end_state, `${label}.cold_baseline.end_state`),
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
      },
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
