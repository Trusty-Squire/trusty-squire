// operate_decide — ask the vaulted TypeSafe Jev (System One) model for a fast
// typed decision (~0.3s per decision measured) instead of spending a full
// host-model turn deciding. Three shapes:
//
//   - default (no `decision`): pick which element ref on the CURRENT page
//     best advances `goal`, built from a fresh compact observation. Payment
//     elements (a=payment / f=payment), offscreen controls, and listener
//     containers are excluded by construction — the payment boundary stays
//     hard; Jev never sees them.
//   - decision:{type:"choice",options}: assign a value FROM the provided
//     options (Jev cannot author values or prose; the caller keeps planning
//     and authoring).
//   - decision:{type:"noul"}: a yes/no validation of `goal` against the
//     current page.
//
// Confidence is first-class and returned verbatim from the model; the CALLER
// gates on it against their own threshold. This tool NEVER acts — no click,
// no type, no submit — it only decides; the caller drives the returned ref.
// See bot/jev-client.ts for the measured wire shapes and retry policy.

import { z } from "zod";
import type { Tool } from "./index.js";
import { assertApi } from "./assert-api.js";
import { observe, withProvisionSessionCall, type Observation } from "../bot/provision-session.js";
import type { SafeControlV2 } from "../bot/compact-observation-v2.js";
import {
  askJev,
  JEV_MODEL,
  type JevQuestion,
  type JevResult,
  type JevUsage,
} from "../bot/jev-client.js";

// Cap on how many page controls become choice options in one decision. The
// measured scout runs stayed far below this; more candidates dilute the
// decision rather than help it.
const MAX_PAGE_OPTIONS = 40;

const MAX_OPTIONS = 100;

const decisionSchema = z.union([
  z.object({
    type: z.literal("choice"),
    options: z
      .record(z.string().min(1).max(200), z.string().min(1).max(400))
      .refine((options) => Object.keys(options).length >= 2, {
        message: "a choice decision needs at least two options",
      })
      .refine((options) => Object.keys(options).length <= MAX_OPTIONS, {
        message: `a choice decision takes at most ${MAX_OPTIONS} options`,
      }),
  }),
  z.object({
    type: z.literal("noul"),
  }),
]);

const decideSchema = z.object({
  session_id: z.string().min(1),
  goal: z.string().min(1).max(2000),
  decision: decisionSchema.optional(),
});

// The payment boundary: Jev is a decision aid for ordinary flows. Payment
// elements never enter its state, so a decision can never route a payment.
interface ParsedRow {
  ref: string;
  role: string;
  label?: string;
  state?: string;
  action?: string;
  field?: string;
  offscreen: boolean;
  notFillable: boolean;
}

// Wire role letters — the inverse of WIRE_ROLE_LETTERS in
// compact-observation-v2.ts; any role outside the table is literal.
const WIRE_ROLES: Record<string, string> = {
  b: "button",
  l: "link",
  t: "textbox",
  s: "select",
  c: "checkbox",
  r: "radio",
  tb: "tab",
  m: "menuitem",
  f: "file",
};

// The compact map's `safe_table` rows travel as `[ref, role, facts?]` on the
// wire (facts is a `|`-joined list: @label alias, s=state, v=offscreen,
// a=action, f=field, q=choice, nf=1 listener container, …). Parse
// defensively so the decide path reads exactly what the driving agent reads
// on the wire, and tolerate the pre-serialization object form too.
function parseRow(raw: unknown): ParsedRow | null {
  if (Array.isArray(raw)) {
    const [ref, roleCode, factsRaw] = raw as unknown[];
    if (typeof ref !== "string" || typeof roleCode !== "string") return null;
    const row: ParsedRow = {
      ref,
      role: WIRE_ROLES[roleCode] ?? roleCode,
      offscreen: false,
      notFillable: false,
    };
    if (typeof factsRaw === "string") {
      for (const fact of factsRaw.split("|")) {
        if (fact.startsWith("@")) row.label = fact.slice(1);
        else if (fact === "v=offscreen") row.offscreen = true;
        else if (fact === "nf=1") row.notFillable = true;
        else if (fact.startsWith("s=")) row.state = fact.slice(2);
        else if (fact.startsWith("a=")) row.action = fact.slice(2);
        else if (fact.startsWith("f=")) row.field = fact.slice(2);
      }
    }
    return row;
  }
  if (typeof raw === "object" && raw !== null) {
    const object = raw as Partial<SafeControlV2>;
    if (typeof object.ref !== "string" || typeof object.role !== "string") return null;
    return {
      ref: object.ref,
      role: object.role,
      ...(object.label !== undefined ? { label: object.label } : {}),
      ...(object.state !== undefined ? { state: object.state } : {}),
      ...(object.action !== undefined ? { action: object.action } : {}),
      ...(object.field !== undefined ? { field: object.field } : {}),
      offscreen: object.visibility === "near",
      notFillable: object.notFillable === true,
    };
  }
  return null;
}

function eligibleForDecision(row: ParsedRow): boolean {
  return row.action !== "payment" && row.field !== "payment" && !row.notFillable;
}

function describeRow(row: ParsedRow): string {
  const parts = [row.role];
  if (row.label !== undefined) parts.push(`@${row.label}`);
  if (row.field !== undefined) parts.push(`(${row.field} field)`);
  if (row.state !== undefined) parts.push(`(state: ${row.state})`);
  return parts.join(" ");
}

function pageState(obs: Observation): string {
  const title = obs.semantic?.title;
  return (
    `Current page: ${obs.url}` +
    (title ? ` (title "${title}")` : "") +
    (obs.stage ? `, stage ${obs.stage}` : "") +
    "."
  );
}

function collectPageOptions(obs: Observation): {
  criteria: Record<string, string>;
  rows: ParsedRow[];
} {
  const rows = (obs.safe_table ?? [])
    .map(parseRow)
    .filter((row): row is ParsedRow => row !== null && row.offscreen === false)
    .filter(eligibleForDecision);
  const criteria: Record<string, string> = {};
  for (const row of rows.slice(0, MAX_PAGE_OPTIONS)) {
    criteria[row.ref] = describeRow(row);
  }
  return { criteria, rows };
}

function requireAnswer(result: JevResult, name: string): JevResult["answers"][string] {
  const answer = result.answers[name];
  if (answer === undefined) {
    throw new Error(
      `jev_invalid_response: no answer for question ${JSON.stringify(name)} (model ${result.model ?? JEV_MODEL})`,
    );
  }
  return answer;
}

function requireChoice(result: JevResult, name: string, criteria: Record<string, string>): string {
  const answer = requireAnswer(result, name);
  const choice = answer.choice;
  if (typeof choice !== "string" || !Object.hasOwn(criteria, choice)) {
    throw new Error(
      `jev_invalid_response: answer for ${JSON.stringify(name)} picked ${JSON.stringify(choice)}` +
        `, which is not one of the offered options (model ${result.model ?? JEV_MODEL})`,
    );
  }
  return choice;
}

function usageBlock(result: JevResult): {
  model: string | null;
  usage: JevUsage | null;
} {
  return { model: result.model ?? null, usage: result.usage ?? null };
}

async function decide(
  args: z.infer<typeof decideSchema>,
  api: NonNullable<Parameters<Tool["handler"]>[1]>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const obs = await observe(args.session_id, "compact");

  let questions: Record<string, JevQuestion>;
  let criteria: Record<string, string>;
  let candidates: { offered: number; eligible: number } | undefined;
  const decision = args.decision;
  if (decision === undefined || decision.type !== "choice") {
    if (decision !== undefined) {
      // decision.type === "noul"
      criteria = {};
      questions = { check: { type: "noul", instructions: args.goal } };
    } else {
      const pageOptions = collectPageOptions(obs);
      const offered = Object.keys(pageOptions.criteria).length;
      if (offered === 0) {
        throw new Error(
          `operate_decide has nothing to decide: no actionable controls are visible on ${obs.url}.` +
            " Scroll, navigate, or decide from a full observation yourself.",
        );
      }
      criteria = pageOptions.criteria;
      candidates = { offered, eligible: pageOptions.rows.length };
      questions = {
        pick: { type: "choice", instructions: args.goal, criteria },
        stuck: {
          type: "noul",
          instructions:
            `Goal: ${args.goal}. The pick question in this batch offers exactly ${offered} page ` +
            `elements as its criteria. Answer yes if none of those ${offered} elements would ` +
            "advance the goal and the page looks stuck for it.",
        },
      };
    }
  } else {
    criteria = decision.options;
    questions = { pick: { type: "choice", instructions: args.goal, criteria } };
  }

  const { result, attempts, elapsedMs } = await askJev(api, pageState(obs), questions, signal);
  const base = {
    session_id: args.session_id,
    url: obs.url,
    ...(obs.stage !== undefined ? { stage: obs.stage } : {}),
    ...usageBlock(result),
    attempts,
    elapsed_ms: elapsedMs,
  };

  if (decision?.type === "noul") {
    const answer = requireAnswer(result, "check");
    return {
      ...base,
      decision: "noul",
      // P(yes). >=0.5 reads as yes; the caller gates on confidence.
      noul: answer.noul ?? null,
      confidence: answer.confidence ?? null,
    };
  }

  const choice = requireChoice(result, "pick", criteria);
  const answer = requireAnswer(result, "pick");
  if (decision === undefined) {
    const picked = (obs.safe_table ?? [])
      .map(parseRow)
      .find((row): row is ParsedRow => row !== null && row.ref === choice);
    const stuck = result.answers.stuck;
    return {
      ...base,
      decision: "pick_ref",
      ref: choice,
      ...(picked?.role !== undefined ? { role: picked.role } : {}),
      ...(picked?.label !== undefined ? { label: picked.label } : {}),
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? null,
      candidates: candidates!,
      stuck: { noul: stuck?.noul ?? null },
    };
  }
  return {
    ...base,
    decision: "pick_option",
    value: choice,
    confidence: answer.confidence ?? null,
    probabilities: answer.probabilities ?? null,
  };
}

export const operateDecideTool: Tool<z.infer<typeof decideSchema>> = {
  name: "operate_decide",
  description:
    "Fast typed decision from the vaulted TypeSafe Jev (System One) model (~0.3s) about the " +
    "operate session's CURRENT page — cheaper than deciding from a full model turn over the " +
    "observation. Three shapes: omit `decision` to pick which element ref on the current page " +
    "best advances `goal` (built from a fresh compact control map; payment elements are " +
    "excluded by construction and a stuck/none-of-these reading comes back alongside); " +
    '`decision:{type:"choice",options}` assigns a value FROM the provided option keys — Jev ' +
    "only assigns, it never authors values or plans, so keep that with you; " +
    '`decision:{type:"noul"}` answers a yes/no validation of `goal` against the page. ' +
    "The response carries the chosen ref (or option key / yes-no probability), per-option " +
    "probabilities, and a CONFIDENCE value straight from the model. Confidence is first-class " +
    "and yours to gate: act on the decision when YOUR confidence threshold is met and escalate " +
    "to reading the observation yourself when it is not — no hidden threshold is applied here. " +
    "NEVER acts: this tool does not click, type, or submit; you drive the returned ref with " +
    "operate_click/operate_type/etc. The call runs through the vaulted `typesafe` credential " +
    "and the key never crosses to this agent. Transient upstream 503/529 unavailability is " +
    "retried with bounded backoff inside a stated budget; on exhaustion the call fails " +
    "honestly with no decision — do not guess, retry shortly or decide from the observation.",
  inputSchema: decideSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "goal"],
    properties: {
      session_id: { type: "string" },
      goal: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "The question or goal, in words.",
      },
      decision: {
        oneOf: [
          {
            type: "object",
            required: ["type", "options"],
            properties: {
              type: { type: "string", enum: ["choice"] },
              options: {
                type: "object",
                minProperties: 2,
                additionalProperties: { type: "string" },
                description: "option key -> description. Jev returns one key.",
              },
            },
          },
          {
            type: "object",
            required: ["type"],
            properties: { type: { type: "string", enum: ["noul"] } },
          },
        ],
      },
    },
  },
  async handler(args, api, context) {
    assertApi(api);
    // Session-addressed surface: run under the session call lease so teardown
    // cannot race an in-flight decision (lifecycle.ts contract).
    return await withProvisionSessionCall(
      args.session_id,
      async () => await decide(args, api, context?.signal),
      context?.signal,
    );
  },
};
