// Jev-driven operate_drive loop. One tool owns observe → decide → gate → act
// until the goal is done or a typed handoff. Planning stays with the host
// agent; Jev only picks among observed refs and provided facts.
//
// Confidence gate: one constant. Coverage matrix (scout report
// ts-jev-navigation-latency §6): every correct answer was >= 0.65, every
// wrong one <= 0.41, and the correct `stuck` stop came at 0.41. 0.6 sits in
// that gap — above every measured miss and the honest stuck stop, below every
// measured correct answer. No second threshold, no per-action-class stops.

import type { ApiClient } from "../api-client.js";
import {
  JevUnavailableError,
  JevRequestError,
  askJev,
  type JevAnswer,
  type JevCallOutcome,
  type JevQuestion,
} from "./jev-client.js";
import {
  act,
  awaitVerification,
  observe,
  startProvisionSession,
  TargetStaleError,
  type Observation,
  type ProvisionAction,
} from "./provision-session.js";
import { sessionForCall } from "./session/lifecycle.js";
import type {
  DriveHandoffQuestion,
  DriveTrajectoryStep,
  Session,
  SessionDriveState,
} from "./session/model.js";

export interface DriveCallContext {
  notifyUser?: (message: string, data?: Record<string, unknown>) => Promise<void>;
  signal?: AbortSignal;
  consentInboxRead?: boolean;
}

export type InjectCardFn = (
  session: Session,
  args: {
    session_id: string;
    merchant: string;
    amount_cents: number;
    currency: string;
    item: string;
    reason: string;
    card_ref: string;
    approval_id?: string;
    fields: {
      pan?: { ref: string; format?: string };
      cvv?: { ref: string; format?: string };
    };
  },
  api: ApiClient,
  options?: DriveCallContext & { pollBudgetMs?: number },
) => Promise<Record<string, unknown>>;

export const DRIVE_CONFIDENCE_THRESHOLD = 0.6;
export const DRIVE_DEFAULT_MAX_STEPS = 15;
export const DRIVE_DEFAULT_MAX_SECONDS = 45;
export const DRIVE_HISTORY_CAP = 20;
export const DRIVE_FIXED_DONE = "done";
export const DRIVE_FIXED_STUCK = "stuck";

const FILLABLE_ROLES = new Set(["t", "s", "textbox", "select"]);
const ROLE_LETTERS: Record<string, string> = {
  button: "b",
  link: "l",
  textbox: "t",
  select: "s",
  checkbox: "c",
  radio: "r",
  tab: "tb",
  menuitem: "m",
  file: "f",
};

const ROLE_WORDS: Record<string, string> = {
  b: "button",
  button: "button",
  l: "link",
  link: "link",
  t: "textbox",
  textbox: "textbox",
  s: "select",
  select: "select",
  c: "checkbox",
  checkbox: "checkbox",
  r: "radio",
  radio: "radio",
  tb: "tab",
  tab: "tab",
  m: "menuitem",
  menuitem: "menuitem",
  f: "file",
  file: "file",
};

export interface DriveCandidate {
  ref: string;
  role: string;
  slug: string;
  description: string;
  row: WireRow;
}

export type DriveStatus =
  | "complete"
  | "needs_value"
  | "stuck"
  | "low_confidence"
  | "no_progress"
  | "budget"
  | "jev_unavailable"
  | "pending_approval"
  | "busy";

export type WireRow = [string, string, string?];

export interface DriveArgs {
  session_id?: string;
  url?: string;
  goal: string;
  facts?: Record<string, string>;
  max_steps?: number;
  max_seconds?: number;
  answer?: string;
}

export interface DriveHandoff {
  status: DriveStatus;
  session_id?: string;
  question?: string;
  options?: Record<string, string>;
  probabilities?: Record<string, number>;
  field?: string;
  observation?: Observation;
  trajectory: DriveTrajectoryStep[];
  done: string;
  remaining: string;
  steps: number;
  seconds: number;
  jev_calls: number;
  jev_retried?: string;
  approval_url?: string;
  payment?: Record<string, unknown>;
}

export interface DriveDependencies {
  askJev: typeof askJev;
  act: typeof act;
  observe: typeof observe;
  startSession: typeof startProvisionSession;
  awaitVerification: typeof awaitVerification;
  injectCard: InjectCardFn;
  now?: () => number;
}

const defaultInjectCard: InjectCardFn = async (session, args, api, options) => {
  const { injectCardOnSession } = await import("../tools/inject-card.js");
  return await injectCardOnSession(session, args, api, options);
};

const defaultDependencies: DriveDependencies = {
  askJev,
  act,
  observe,
  startSession: startProvisionSession,
  awaitVerification,
  injectCard: defaultInjectCard,
};

export function emptyDriveState(goal: string, facts: Record<string, string>): SessionDriveState {
  return {
    running: false,
    goal,
    facts: { ...facts },
    trajectory: [],
    history: [],
    lastQuestion: null,
    lastActionKey: null,
    lastFingerprint: null,
    jevCalls: 0,
  };
}

export function mergeFacts(
  existing: Record<string, string>,
  added: Record<string, string> | undefined,
): Record<string, string> {
  return added === undefined ? { ...existing } : { ...existing, ...added };
}

export function wireRowsFromObservation(observation: {
  safe_table?: unknown;
} | undefined): WireRow[] {
  const table = observation?.safe_table;
  if (!Array.isArray(table)) return [];
  const rows: WireRow[] = [];
  for (const entry of table) {
    const wired = toWireRow(entry);
    if (wired !== undefined) rows.push(wired);
  }
  return rows;
}

function toWireRow(entry: unknown): WireRow | undefined {
  if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
    return entry[2] === undefined
      ? [entry[0], entry[1]]
      : [entry[0], entry[1], String(entry[2])];
  }
  if (typeof entry !== "object" || entry === null) return undefined;
  const row = entry as {
    ref?: unknown;
    role?: unknown;
    label?: unknown;
    visibility?: unknown;
    state?: unknown;
    action?: unknown;
    field?: unknown;
    choice?: unknown;
    frame?: unknown;
    acted?: unknown;
    notFillable?: unknown;
  };
  if (typeof row.ref !== "string" || typeof row.role !== "string") return undefined;
  const role = ROLE_LETTERS[row.role] ?? row.role;
  const facts = [
    typeof row.label === "string" ? row.label : undefined,
    row.visibility === "near" ? "v=offscreen" : undefined,
    typeof row.state === "string" ? `s=${row.state}` : undefined,
    typeof row.action === "string" ? `a=${row.action}` : undefined,
    typeof row.field === "string" ? `f=${row.field}` : undefined,
    typeof row.choice === "string" ? `q=${row.choice}` : undefined,
    row.frame === "same_origin" ? "x=s" : row.frame === "cross_origin" ? "x=x" : undefined,
    row.acted === true ? "w=acted" : undefined,
    row.notFillable === true ? "nf=1" : undefined,
  ].filter((value): value is string => value !== undefined);
  return facts.length === 0 ? [row.ref, role] : [row.ref, role, facts.join("|")];
}

export function mergeCompactTable(
  previous: WireRow[],
  next: { delta?: boolean; removed?: string[]; safe_table?: unknown },
): WireRow[] {
  const incoming = wireRowsFromObservation(next);
  if (next.delta !== true) return incoming;
  const byRef = new Map<string, WireRow>(previous.map((row) => [row[0], row]));
  for (const row of incoming) byRef.set(row[0], row);
  for (const ref of next.removed ?? []) byRef.delete(ref);
  return [...byRef.values()];
}

export function observationFingerprint(url: string, rows: readonly WireRow[]): string {
  const stable = rows.map(([ref, role, facts]) => {
    const withoutActed = (facts ?? "")
      .split("|")
      .filter((part) => part !== "w=acted")
      .join("|");
    return `${ref}\t${role}\t${withoutActed}`;
  });
  return `${url}\n${stable.join("\n")}`;
}

export function rowLabel(row: WireRow): string {
  const facts = row[2];
  if (facts === undefined || facts.length === 0) return row[0];
  const first = facts.split("|")[0] ?? row[0];
  if (first.includes("=")) return row[0];
  return first.startsWith("@") ? first : first;
}

export function readableLabel(row: WireRow): string {
  const labeled = rowLabel(row).replace(/^@/, "");
  if (labeled.length === 0 || labeled.startsWith("@e:")) {
    const field = rowField(row);
    if (field !== undefined && field.length > 0 && field !== "payment") return field;
    return "control";
  }
  return labeled;
}

export function rowField(row: WireRow): string | undefined {
  const facts = row[2];
  if (facts === undefined) return undefined;
  const match = /(?:^|\|)f=([^|]+)/.exec(facts);
  return match?.[1];
}

export function isFillableRow(row: WireRow): boolean {
  if ((row[2] ?? "").includes("nf=1")) return false;
  return FILLABLE_ROLES.has(row[1]);
}

export function isPaymentRow(row: WireRow): boolean {
  const facts = row[2] ?? "";
  const label = readableLabel(row).toLowerCase();
  return (
    facts.includes("f=payment") ||
    facts.includes("a=payment") ||
    /card[- ]?number|\bpan\b|credit[- ]?card/.test(label) ||
    /cvv|cvc|cid|security[- ]?code/.test(label)
  );
}

export function isOffscreenRow(row: WireRow): boolean {
  return (row[2] ?? "").includes("v=offscreen");
}

export function isDisabledRow(row: WireRow): boolean {
  return /(?:^|\|)s=d(?:\||$)/.test(row[2] ?? "");
}

export function isCandidateRow(row: WireRow, includePayment: boolean): boolean {
  if (isOffscreenRow(row) || isDisabledRow(row)) return false;
  if (!includePayment && (isPaymentRow(row) || isCvvRow(row))) return false;
  return true;
}

export function isCvvRow(row: WireRow): boolean {
  const label = rowLabel(row).toLowerCase();
  return /cvv|cvc|cid|security[- ]?code/.test(label);
}

export function isGoogleAuthRow(row: WireRow): boolean {
  const label = rowLabel(row).toLowerCase();
  return /google/.test(label) && (row[1] === "b" || row[1] === "l" || row[1] === "button" || row[1] === "link");
}

export function isOtpRow(row: WireRow): boolean {
  const label = rowLabel(row).toLowerCase();
  const field = rowField(row) ?? "";
  return /otp|verif|one[- ]?time|\bcode\b|\bpin\b/.test(`${label} ${field}`);
}

const FIELD_ALIASES: Record<string, readonly string[]> = {
  email: ["email", "user_email", "login", "username"],
  first_name: ["first_name", "firstname", "first", "given_name"],
  last_name: ["last_name", "lastname", "last", "family_name", "surname"],
  name: ["name", "full_name", "fullname", "cardholder", "cardholder_name"],
  company: ["company", "organization", "org", "business"],
  address: ["address", "address1", "line1", "street", "address_line1"],
  address2: ["address2", "line2", "address_line2"],
  city: ["city", "locality", "town"],
  state: ["state", "region", "province"],
  zip: ["zip", "postal", "postcode", "postal_code", "zipcode"],
  country: ["country"],
  phone: ["phone", "tel", "telephone", "mobile"],
  password: ["password", "password_label"],
  otp: ["otp", "code", "verification_code", "pin"],
};

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function fieldNameForRow(row: WireRow): string {
  const field = rowField(row);
  if (field !== undefined && field.length > 0 && field !== "payment") return field;
  return readableLabel(row);
}

export function fieldLabelForRow(row: WireRow): string {
  return readableLabel(row);
}

export function matchingFactKeys(facts: Record<string, string>, row: WireRow): string[] {
  const keys = Object.keys(facts);
  if (keys.length === 0) return [];
  const field = normalizeKey(fieldNameForRow(row));
  const aliases = Object.entries(FIELD_ALIASES).find(
    ([name, list]) => name === field || list.includes(field) || field.includes(name),
  );
  const wanted = new Set<string>([field, ...(aliases?.[1] ?? [])]);
  const matched = keys.filter((key) => wanted.has(normalizeKey(key)));
  return matched.length > 0 ? matched : [];
}

export function slugifyCriteriaKey(seed: string): string {
  return (
    "k" +
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40)
  );
}

export function actionDescription(row: WireRow): string {
  const label = readableLabel(row);
  const role = ROLE_WORDS[row[1]] ?? "control";
  if (isFillableRow(row)) {
    if (row[1] === "s" || row[1] === "select") return `choose an option in the ${label} field`;
    return `type into the ${label} field`;
  }
  if (row[1] === "c" || row[1] === "checkbox") return `toggle the checkbox labeled "${label}"`;
  return `click the ${role} labeled "${label}"`;
}

export function driveCandidates(
  rows: readonly WireRow[],
  includePayment: boolean,
): DriveCandidate[] {
  const used = new Set<string>();
  const candidates: DriveCandidate[] = [];
  for (const row of rows) {
    if (!isCandidateRow(row, includePayment)) continue;
    const role = ROLE_LETTERS[row[1]] ?? row[1];
    const seed = `${row[2] ?? readableLabel(row)}_${role}`;
    let slug = slugifyCriteriaKey(seed);
    let n = 2;
    while (used.has(slug)) {
      slug = slugifyCriteriaKey(`${seed}_${n}`);
      n += 1;
    }
    used.add(slug);
    candidates.push({
      ref: row[0],
      role,
      slug,
      description: actionDescription(row),
      row,
    });
  }
  return candidates;
}

export function compactRowsText(url: string, stage: string | undefined, rows: readonly WireRow[]): string {
  const header = stage === undefined ? url : `${url} stage=${stage}`;
  return `${header}\n${JSON.stringify(rows)}`;
}

export function nextActionInstructions(goal: string): string {
  return (
    `You are driving a browser to: ${goal}. Pick the single next action that advances it. ` +
    "Pick done if it is already complete; pick stuck if no listed element advances it."
  );
}

export function buildJevState(
  goal: string,
  factKeys: readonly string[],
  history: readonly string[],
  url: string,
  title: string | undefined,
  candidates: readonly DriveCandidate[],
): string {
  const recent = history.slice(-DRIVE_HISTORY_CAP);
  const titlePart = title === undefined || title.length === 0 ? "" : ` (title: ${title})`;
  const facts = factKeys.length === 0 ? "(none)" : factKeys.join(", ");
  const taken = recent.length === 0 ? "(none)" : recent.join(" -> ");
  const elements =
    candidates.length === 0
      ? "(none)"
      : candidates.map((candidate) => `- ${candidate.description}`).join("\n");
  return (
    `Page: ${url}${titlePart}. Goal: ${goal}. Facts available: ${facts}. ` +
    `Actions already taken, in order: ${taken}. ` +
    "If the last action did not change the page, do NOT repeat it. " +
    `Visible interactive elements:\n${elements}`
  );
}

export function actionCriteria(
  rows: readonly WireRow[],
  includePayment: boolean = false,
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const candidate of driveCandidates(rows, includePayment)) {
    criteria[candidate.slug] = candidate.description;
  }
  criteria[DRIVE_FIXED_DONE] = "the goal is already complete; stop";
  criteria[DRIVE_FIXED_STUCK] = "no listed element advances the goal; stop";
  return criteria;
}

export function valueCriteria(facts: Record<string, string>, row?: WireRow): Record<string, string> {
  const keys = row === undefined ? Object.keys(facts) : matchingFactKeys(facts, row);
  const from = keys.length > 0 ? keys : Object.keys(facts);
  const criteria: Record<string, string> = {};
  for (const key of from) {
    criteria[key] = `the provided ${key} value`;
  }
  return criteria;
}

export function buildDriveQuestions(
  rows: readonly WireRow[],
  facts: Record<string, string>,
  goal: string,
  includePayment: boolean = Boolean(facts.card_ref),
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {
    next_action: {
      type: "choice",
      instructions: nextActionInstructions(goal),
      criteria: actionCriteria(rows, includePayment),
    },
    goal_complete: {
      type: "noul",
      instructions: "Is the stated goal already complete on this page?",
    },
  };
  const fillable = driveCandidates(rows, includePayment).some((candidate) => isFillableRow(candidate.row));
  if (Object.keys(facts).length > 0 && fillable) {
    questions.value = {
      type: "choice",
      instructions:
        "If the next action is typing into a field or choosing a select option, which fact supplies the value? Never invent a value.",
      criteria: valueCriteria(facts),
    };
  }
  return questions;
}

export function confidenceOf(answer: JevAnswer | undefined): number {
  if (answer === undefined) return 0;
  if (typeof answer.confidence === "number") return answer.confidence;
  if (typeof answer.noul === "number") return answer.noul;
  return 0;
}

export function gated(
  answer: JevAnswer | undefined,
  threshold: number = DRIVE_CONFIDENCE_THRESHOLD,
): boolean {
  return confidenceOf(answer) >= threshold;
}

export type DriveDecision =
  | { kind: "complete"; confidence: number }
  | { kind: "stuck"; confidence: number }
  | { kind: "no_progress" }
  | {
      kind: "low_confidence";
      question: DriveHandoffQuestion;
    }
  | { kind: "needs_value"; field: string }
  | {
      kind: "act";
      action: ProvisionAction;
      actionKey: string;
      confidence: number;
      special?: "oauth" | "inbox" | "card";
    };

export function resolveActionChoice(
  choice: string,
  candidates: readonly DriveCandidate[],
): DriveCandidate | undefined {
  return candidates.find((candidate) => candidate.slug === choice || candidate.ref === choice);
}

function lowConfidenceQuestion(
  instructions: string,
  criteria: Record<string, string>,
  answer: JevAnswer | undefined,
): DriveDecision {
  return {
    kind: "low_confidence",
    question: {
      question: instructions,
      options: criteria,
      ...(answer?.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
    },
  };
}

export function decideAfterJev(input: {
  answers: Record<string, JevAnswer>;
  rows: readonly WireRow[];
  facts: Record<string, string>;
  lastFingerprint: string | null;
  lastActionKey: string | null;
  fingerprint: string;
  goal: string;
  cardRef?: string;
  threshold?: number;
}): DriveDecision {
  const threshold = input.threshold ?? DRIVE_CONFIDENCE_THRESHOLD;
  const includePayment = input.cardRef !== undefined;
  const candidates = driveCandidates(input.rows, includePayment);
  const criteria = actionCriteria(input.rows, includePayment);
  const instructions = nextActionInstructions(input.goal);
  const complete = input.answers.goal_complete;
  if (gated(complete, threshold)) {
    return { kind: "complete", confidence: complete?.noul ?? 1 };
  }
  const next = input.answers.next_action;
  const resolved =
    next?.choice === undefined ? undefined : resolveActionChoice(next.choice, candidates);
  const knownChoice =
    next?.choice !== undefined &&
    (criteria[next.choice] !== undefined || resolved !== undefined);
  if (!gated(next, threshold) || next?.choice === undefined || !knownChoice) {
    return lowConfidenceQuestion(instructions, criteria, next);
  }
  const choice = next.choice;
  const confidence = confidenceOf(next);
  if (choice === DRIVE_FIXED_DONE) return { kind: "complete", confidence };
  if (choice === DRIVE_FIXED_STUCK) {
    return { kind: "stuck", confidence };
  }
  const candidate = resolved ?? resolveActionChoice(choice, candidates);
  if (candidate === undefined) {
    return lowConfidenceQuestion(instructions, criteria, next);
  }
  if (input.lastFingerprint === input.fingerprint && input.lastActionKey === candidate.ref) {
    return { kind: "no_progress" };
  }
  const row = candidate.row;
  const ref = candidate.ref;
  if (isFillableRow(row) && isOtpRow(row)) {
    return {
      kind: "act",
      action: { kind: "type", target: ref, text: "" },
      actionKey: ref,
      confidence,
      special: "inbox",
    };
  }
  if (isFillableRow(row)) {
    const matched = matchingFactKeys(input.facts, row);
    const valueAnswer = input.answers.value;
    if (matched.length === 0) {
      return { kind: "needs_value", field: fieldLabelForRow(row) };
    }
    if (valueAnswer !== undefined && !gated(valueAnswer, threshold)) {
      return lowConfidenceQuestion(
        "Which fact supplies the value for this field?",
        valueCriteria(input.facts, row),
        valueAnswer,
      );
    }
    const valueKey = valueAnswer?.choice;
    if (valueKey === undefined || input.facts[valueKey] === undefined || !matched.includes(valueKey)) {
      return { kind: "needs_value", field: fieldLabelForRow(row) };
    }
    const text = input.facts[valueKey]!;
    const action: ProvisionAction =
      row[1] === "s" || row[1] === "select"
        ? { kind: "select", target: ref, text }
        : { kind: "type", target: ref, text };
    const special = isPaymentRow(row) && input.cardRef !== undefined ? "card" : undefined;
    return { kind: "act", action, actionKey: ref, confidence, ...(special === undefined ? {} : { special }) };
  }
  if (isPaymentRow(row) && input.cardRef !== undefined) {
    return {
      kind: "act",
      action: { kind: "click", target: ref },
      actionKey: ref,
      confidence,
      special: "card",
    };
  }
  if (isGoogleAuthRow(row)) {
    return {
      kind: "act",
      action: { kind: "oauth_login", target: ref, provider: "google" },
      actionKey: ref,
      confidence,
      special: "oauth",
    };
  }
  return {
    kind: "act",
    action: { kind: "click", target: ref },
    actionKey: ref,
    confidence,
  };
}

export function noProgressDecision(input: {
  fingerprint: string;
  lastFingerprint: string | null;
  actionKey: string;
  lastActionKey: string | null;
}): boolean {
  return input.lastFingerprint === input.fingerprint && input.lastActionKey === actionKeyOf(input);
}

function actionKeyOf(input: { actionKey: string }): string {
  return input.actionKey;
}

export function buildHandoff(input: {
  status: DriveStatus;
  sessionId?: string;
  observation?: Observation;
  trajectory: readonly DriveTrajectoryStep[];
  goal: string;
  steps: number;
  seconds: number;
  jevCalls: number;
  question?: DriveHandoffQuestion;
  field?: string;
  jevRetried?: string;
  approvalUrl?: string;
  payment?: Record<string, unknown>;
}): DriveHandoff {
  const done =
    input.status === "complete"
      ? input.goal
      : input.trajectory.length === 0
        ? "nothing yet"
        : input.trajectory
            .slice(-8)
            .map((step) => `${step.action} ${step.target}`)
            .join("; ");
  const remaining = input.status === "complete" ? "none" : input.goal;
  return {
    status: input.status,
    ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
    ...(input.question === undefined
      ? {}
      : {
          question: input.question.question,
          options: input.question.options,
          ...(input.question.probabilities === undefined
            ? {}
            : { probabilities: input.question.probabilities }),
        }),
    ...(input.field === undefined ? {} : { field: input.field }),
    ...(input.observation === undefined ? {} : { observation: input.observation }),
    trajectory: input.trajectory.slice(-DRIVE_HISTORY_CAP),
    done,
    remaining,
    steps: input.steps,
    seconds: input.seconds,
    jev_calls: input.jevCalls,
    ...(input.jevRetried === undefined ? {} : { jev_retried: input.jevRetried }),
    ...(input.approvalUrl === undefined ? {} : { approval_url: input.approvalUrl }),
    ...(input.payment === undefined ? {} : { payment: input.payment }),
  };
}

function handoffObservation(observation: Observation, rows: WireRow[]): Observation {
  const rest = { ...observation };
  delete rest.delta;
  delete rest.removed;
  // Compact maps on the wire are [ref, role, facts?] tuples. Observation.safe_table
  // is typed as SafeControlV2 objects; the primitives emit tuples, and the
  // handoff must return that same map.
  return {
    ...rest,
    safe_table: rows as unknown as NonNullable<Observation["safe_table"]>,
  };
}

function findRow(rows: readonly WireRow[], refOrSlug: string): WireRow | undefined {
  const byRef = rows.find((row) => row[0] === refOrSlug || rowLabel(row) === refOrSlug);
  if (byRef !== undefined) return byRef;
  for (const includePayment of [false, true]) {
    const hit = driveCandidates(rows, includePayment).find((candidate) => candidate.slug === refOrSlug);
    if (hit !== undefined) return hit.row;
  }
  return undefined;
}

function paymentFields(rows: readonly WireRow[]): { pan?: string; cvv?: string } {
  let pan: string | undefined;
  let cvv: string | undefined;
  for (const row of rows) {
    if (!isPaymentRow(row) && !isCvvRow(row)) continue;
    if (isCvvRow(row)) cvv = row[0];
    else if (isFillableRow(row) || isPaymentRow(row)) pan = pan ?? row[0];
  }
  return { ...(pan === undefined ? {} : { pan }), ...(cvv === undefined ? {} : { cvv }) };
}

function paymentArgs(
  session: Session,
  facts: Record<string, string>,
  goal: string,
  url: string,
  rows: readonly WireRow[],
): Parameters<InjectCardFn>[1] | undefined {
  const cardRef = facts.card_ref;
  if (cardRef === undefined) return undefined;
  const fields = paymentFields(rows);
  if (fields.pan === undefined && fields.cvv === undefined) return undefined;
  let hostname = "checkout";
  try {
    hostname = new URL(url).hostname;
  } catch {
    hostname = "checkout";
  }
  const amount = Number.parseInt(facts.amount_cents ?? "0", 10);
  return {
    session_id: session.id,
    merchant: facts.merchant ?? hostname,
    amount_cents: Number.isFinite(amount) ? amount : 0,
    currency: facts.currency ?? "USD",
    item: facts.item ?? goal,
    reason: facts.reason ?? goal,
    card_ref: cardRef,
    ...(session.activePayment?.status === "awaiting_approval"
      ? { approval_id: session.activePayment.state.approval_id }
      : session.releasedPaymentCard !== null
        ? { approval_id: session.releasedPaymentCard.approvalId }
        : {}),
    fields: {
      ...(fields.pan === undefined ? {} : { pan: { ref: fields.pan } }),
      ...(fields.cvv === undefined ? {} : { cvv: { ref: fields.cvv } }),
    },
  };
}

function cardInjected(result: Record<string, unknown>): boolean {
  return result.status === "card_injected" || result.status === "card_released";
}

async function actSafely(
  deps: DriveDependencies,
  sessionId: string,
  action: ProvisionAction,
): Promise<Observation> {
  try {
    return await deps.act(sessionId, action, "compact", "compact", true);
  } catch (error) {
    if (error instanceof TargetStaleError) return await deps.observe(sessionId, "compact");
    throw error;
  }
}

function resumeAction(
  answer: string,
  rows: readonly WireRow[],
  facts: Record<string, string>,
  goal: string,
  cardRef: string | undefined,
): DriveDecision {
  if (answer === DRIVE_FIXED_DONE) return { kind: "complete", confidence: 1 };
  if (answer === DRIVE_FIXED_STUCK) {
    return { kind: "stuck", confidence: 1 };
  }
  const row = findRow(rows, answer);
  if (row === undefined) {
    return {
      kind: "low_confidence",
      question: {
        question: "Resume answer is not a current option",
        options: actionCriteria(rows, cardRef !== undefined),
      },
    };
  }
  const valueKey = matchingFactKeys(facts, row)[0] ?? Object.keys(facts)[0];
  return decideAfterJev({
    answers: {
      next_action: { choice: row[0], confidence: 1 },
      goal_complete: { noul: 0 },
      ...(isFillableRow(row) && valueKey !== undefined
        ? { value: { choice: valueKey, confidence: 1 } }
        : {}),
    },
    rows,
    facts,
    lastFingerprint: null,
    lastActionKey: null,
    fingerprint: "resume",
    goal,
    ...(cardRef === undefined ? {} : { cardRef }),
  });
}

export async function runOperateDrive(
  args: DriveArgs,
  api: ApiClient | null,
  context?: DriveCallContext,
  dependencies: DriveDependencies = defaultDependencies,
): Promise<DriveHandoff> {
  const now = dependencies.now ?? Date.now;
  const maxSteps = args.max_steps ?? DRIVE_DEFAULT_MAX_STEPS;
  const maxSeconds = args.max_seconds ?? DRIVE_DEFAULT_MAX_SECONDS;
  const started = now();
  const elapsed = (): number => (now() - started) / 1000;
  const remainingMs = (): number => Math.max(0, maxSeconds * 1000 - (now() - started));

  let sessionId = args.session_id;
  let observation: Observation | undefined;
  if (sessionId === undefined) {
    const url = args.url;
    if (url === undefined) {
      return buildHandoff({
        status: "needs_value",
        trajectory: [],
        goal: args.goal,
        steps: 0,
        seconds: elapsed(),
        jevCalls: 0,
        field: "session_id",
      });
    }
    observation = await dependencies.startSession({
      serviceUrl: url,
      format: "compact",
      consentInboxRead: context?.consentInboxRead !== false,
      ...(api === null ? {} : { api }),
    });
    sessionId = observation.session_id;
    // A Google-gated start mints an id but no browser session. That connect
    // wall is operate_start's existing hand-back, not a drive-loop stop.
    if (sessionForCall(sessionId) === undefined) {
      return buildHandoff({
        status: "needs_value",
        sessionId,
        observation,
        trajectory: [],
        goal: args.goal,
        steps: 0,
        seconds: elapsed(),
        jevCalls: 0,
        field: observation.needs_user?.wall ?? "session",
        ...(observation.needs_user === undefined
          ? {}
          : { question: { question: observation.needs_user.message, options: {} } }),
      });
    }
  }

  const session = sessionForCall(sessionId);
  if (session === undefined) throw new Error(`unknown provision session ${sessionId}`);
  if (session.drive?.running === true) {
    return buildHandoff({
      status: "busy",
      sessionId,
      ...(observation === undefined ? {} : { observation }),
      trajectory: session.drive.trajectory,
      goal: session.drive.goal,
      steps: 0,
      seconds: elapsed(),
      jevCalls: session.drive.jevCalls,
    });
  }

  const facts = mergeFacts(session.drive?.facts ?? {}, args.facts);
  const drive = session.drive ?? emptyDriveState(args.goal, facts);
  drive.running = true;
  drive.goal = args.goal;
  drive.facts = facts;
  session.drive = drive;

  try {
    return await driveLoop({
      session,
      sessionId,
      observation,
      args,
      api,
      ...(context === undefined ? {} : { context }),
      dependencies,
      maxSteps,
      elapsed,
      remainingMs,
    });
  } finally {
    const live = sessionForCall(sessionId);
    if (live?.drive !== undefined && live.drive !== null) live.drive.running = false;
  }
}

async function driveLoop(input: {
  session: Session;
  sessionId: string;
  observation: Observation | undefined;
  args: DriveArgs;
  api: ApiClient | null;
  context?: DriveCallContext;
  dependencies: DriveDependencies;
  maxSteps: number;
  elapsed: () => number;
  remainingMs: () => number;
}): Promise<DriveHandoff> {
  const { session, sessionId, args, api, context, dependencies, maxSteps, elapsed, remainingMs } =
    input;
  const driveState = session.drive;
  if (driveState === null) throw new Error("drive state missing");
  const drive = driveState;
  let observation: Observation =
    input.observation !== undefined && input.observation.safe_table !== undefined
      ? input.observation
      : await dependencies.observe(sessionId, "compact");
  let rows = mergeCompactTable([], observation);
  let steps = 0;

  const finish = (
    status: DriveStatus,
    extra: Omit<Parameters<typeof buildHandoff>[0], "status" | "sessionId" | "observation" | "trajectory" | "goal" | "steps" | "seconds" | "jevCalls"> = {},
  ): DriveHandoff =>
    buildHandoff({
      status,
      sessionId,
      observation: handoffObservation(observation, rows),
      trajectory: drive.trajectory,
      goal: drive.goal,
      steps,
      seconds: elapsed(),
      jevCalls: drive.jevCalls,
      ...extra,
    });

  const applyDecision = async (decision: DriveDecision, jevMs?: number): Promise<DriveHandoff | "continue"> => {
    if (decision.kind === "complete") {
      return finish("complete");
    }
    if (decision.kind === "stuck") {
      drive.lastQuestion = {
        question: nextActionInstructions(drive.goal),
        options: actionCriteria(rows, drive.facts.card_ref !== undefined),
      };
      return finish("stuck", { question: drive.lastQuestion });
    }
    if (decision.kind === "needs_value") {
      drive.lastQuestion = {
        question: `Missing value for ${decision.field}`,
        options: Object.fromEntries(
          Object.keys(drive.facts).map((key) => [key, `the provided ${key} value`]),
        ),
      };
      return finish("needs_value", { field: decision.field, question: drive.lastQuestion });
    }
    if (decision.kind === "no_progress") {
      return finish("no_progress");
    }
    if (decision.kind === "low_confidence") {
      drive.lastQuestion = decision.question;
      return finish("low_confidence", { question: decision.question });
    }
    const fingerprint = observationFingerprint(observation?.url ?? "", rows);
    if (
      noProgressDecision({
        fingerprint,
        lastFingerprint: drive.lastFingerprint,
        actionKey: decision.actionKey,
        lastActionKey: drive.lastActionKey,
      })
    ) {
      return finish("no_progress");
    }

    if (decision.special === "card") {
      if (api === null) {
        return finish("jev_unavailable", {
          jevRetried: "inject_card requires an active Trusty Squire session",
        });
      }
      const card = paymentArgs(session, drive.facts, drive.goal, observation?.url ?? "", rows);
      if (card === undefined) {
        return finish("needs_value", { field: "card_ref" });
      }
      const payment = await dependencies.injectCard(session, card, api, {
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
        ...(context?.notifyUser === undefined ? {} : { notifyUser: context.notifyUser }),
        pollBudgetMs: remainingMs(),
      });
      drive.trajectory.push({
        action: "inject_card",
        target: card.card_ref,
        confidence: decision.confidence,
        url: observation?.url ?? "",
        ...(observation?.stage === undefined ? {} : { stage: observation.stage }),
        ...(jevMs === undefined ? {} : { jev_ms: jevMs }),
      });
      drive.history.push("inject card");
      if (!cardInjected(payment)) {
        const approvalUrl =
          typeof payment.approval_url === "string" ? payment.approval_url : undefined;
        return finish("pending_approval", {
          ...(approvalUrl === undefined ? {} : { approvalUrl }),
          payment,
        });
      }
      observation = await dependencies.observe(sessionId, "compact");
      rows = mergeCompactTable(rows, observation);
      drive.lastFingerprint = observationFingerprint(observation.url, rows);
      drive.lastActionKey = decision.actionKey;
      return "continue";
    }

    if (decision.special === "inbox") {
      const verification = await dependencies.awaitVerification(sessionId);
      if (verification.found && verification.code !== null && decision.action.kind === "type") {
        observation = await actSafely(dependencies, sessionId, {
          kind: "type",
          target: decision.action.target,
          text: verification.code,
        });
      } else if (verification.found && verification.link !== null) {
        observation = await actSafely(dependencies, sessionId, {
          kind: "goto",
          url: verification.link,
        });
      } else {
        return finish("needs_value", { field: "verification_code" });
      }
      rows = mergeCompactTable(rows, observation);
      drive.trajectory.push({
        action: verification.code !== null ? "type_otp" : "goto_verify",
        target: decision.actionKey,
        confidence: decision.confidence,
        url: observation.url,
        ...(observation.stage === undefined ? {} : { stage: observation.stage }),
        ...(jevMs === undefined ? {} : { jev_ms: jevMs }),
      });
      drive.history.push(verification.code !== null ? "type verification code" : "open verification link");
      drive.lastFingerprint = observationFingerprint(observation.url, rows);
      drive.lastActionKey = decision.actionKey;
      return "continue";
    }

    observation = await actSafely(dependencies, sessionId, decision.action);
    const historyLine = (() => {
      const acted = findRow(rows, decision.actionKey);
      return acted === undefined ? decision.action.kind : actionDescription(acted);
    })();
    rows = mergeCompactTable(rows, observation);
    drive.trajectory.push({
      action: decision.action.kind,
      target: decision.actionKey,
      confidence: decision.confidence,
      url: observation.url,
      ...(observation.stage === undefined ? {} : { stage: observation.stage }),
      ...(jevMs === undefined ? {} : { jev_ms: jevMs }),
    });
    drive.history.push(historyLine);
    drive.lastFingerprint = observationFingerprint(observation.url, rows);
    drive.lastActionKey = decision.actionKey;
    return "continue";
  };

  if (args.answer !== undefined) {
    const resumed = await applyDecision(
      resumeAction(args.answer, rows, drive.facts, drive.goal, drive.facts.card_ref),
    );
    if (resumed !== "continue") return resumed;
    steps += 1;
  }

  while (steps < maxSteps && remainingMs() > 0) {
    if (observation === undefined) {
      observation = await dependencies.observe(sessionId, "compact");
      rows = mergeCompactTable(rows, observation);
    }
    if (api === null) {
      return finish("jev_unavailable", {
        jevRetried: "askJev requires an active Trusty Squire session (vaulted typesafe credential)",
      });
    }
    const includePayment = drive.facts.card_ref !== undefined;
    const questions = buildDriveQuestions(rows, drive.facts, drive.goal, includePayment);
    const candidates = driveCandidates(rows, includePayment);
    const state = buildJevState(
      drive.goal,
      Object.keys(drive.facts),
      drive.history,
      observation.url,
      observation.semantic?.title,
      candidates,
    );
    let jev: JevCallOutcome;
    try {
      jev = await dependencies.askJev(api, state, questions, context?.signal);
    } catch (error) {
      if (error instanceof JevUnavailableError || error instanceof JevRequestError) {
        return finish("jev_unavailable", { jevRetried: error.message });
      }
      throw error;
    }
    drive.jevCalls += 1;
    const decision = decideAfterJev({
      answers: jev.result.answers,
      rows,
      facts: drive.facts,
      lastFingerprint: drive.lastFingerprint,
      lastActionKey: drive.lastActionKey,
      fingerprint: observationFingerprint(observation.url, rows),
      goal: drive.goal,
      ...(drive.facts.card_ref === undefined ? {} : { cardRef: drive.facts.card_ref }),
    });
    const applied = await applyDecision(decision, jev.elapsedMs);
    if (applied !== "continue") return applied;
    steps += 1;
  }

  return finish("budget");
}
