// Phase 1 — the interactive provisioning tool surface a frontier HOST agent
// drives. The host is the planner; these tools are the browser + the moat.
// Backed by ../bot/provision-session.ts (the session registry over the existing
// BrowserController substrate).
// Domain-scoping, the write-only-vault de-fang, and a per-action audit log are
// in place; the consent-at-install prompt is the remaining hardening.

import { z } from "zod";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import type { Tool } from "./index.js";
import type { ApiClient } from "../api-client.js";
import {
  startProvisionSession,
  observe,
  act,
  cartAdd,
  formSelectMany,
  TargetStaleError,
  extractCredentials,
  captchaGate,
  awaitVerification,
  finishProvisionSession,
  finishProvisionSessionWithPreparation,
  observedHostsForSession,
  currentProvisionUrl,
  stashSecretSlot,
  readSecretSlotValue,
  getSessionUserEmail,
  generatePassword,
  rememberRecipe,
  verifyActiveRecipePostcondition,
  verifySavedRecipePostcondition,
  captureAndPromoteSession,
  replayOperatorRecipe,
  emitProvisionMeasurement,
  checkoutShapeSignatureForSession,
  type ProvisionAction,
  type ExtractResult,
  manualCardEntryBlockReason,
} from "../bot/provision-session.js";
import { signSkillForPublish } from "../skill-cli/signing.js";
import {
  readRecipe,
  readRecipeForTask,
  readRecipeForCheckoutShape,
  readRecipeFromFile,
  renderOperatorRecipeHint,
  recipeEntryUrl,
  fillTemplate,
  operatorRecipeDomain,
  checkoutShapeKey,
  isCheckoutShapeKey,
  isSameRecipeDomain,
  OperatorVerbSchema,
  RecipeHoleSchema,
  PostconditionSchema,
  type OperatorVerb,
  type OperatorRecipe,
} from "../bot/operator-recipe.js";
import { isMaskedDisplay } from "../bot/credential-shape.js";
import { renderSkillHint, serviceSlugFromUrl } from "../bot/skill-hint.js";
import { clientFromEnv, generateProvisionId } from "../skill-registry-client.js";
import { openSessionStorage } from "../session.js";

// PR2 — read the install-time inbox-read consent. Default-OFF: a missing flag
// (older sessions, no session file) means "not consented", so awaitVerification
// fails closed and hands the code request back to the user. Operator/housekeeper
// deployments set consent_operator_inbox_otp=true.
async function readInboxConsent(): Promise<boolean> {
  try {
    const storage = await openSessionStorage();
    const data = await storage.read();
    return data?.consent_operator_inbox_otp === true;
  } catch {
    return false;
  }
}

// The account the install is bound to. Operator/CI runs set it in the env;
// end-user installs bind it in session.json (connect writes it there, NOT to the
// MCP config env). Reading env-only silently disabled BOTH the hint read and the
// auto-promote write for every end-user install — resolve from the session file
// as the fallback so the registry loop works off a normal `connect`.
async function resolveAccountId(): Promise<string | undefined> {
  const fromEnv = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  try {
    const data = await (await openSessionStorage()).read();
    const id = data?.account_id;
    return id !== undefined && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

// Best-effort: ask the registry for a known route for this service so the agent
// drives on rails instead of ad-hoc. Returns undefined on any miss (no skill,
// no registry configured, network error) — the agent just drives without it.
async function resolveRouteHint(serviceUrl: string): Promise<string | undefined> {
  try {
    const accountId = await resolveAccountId();
    if (accountId === undefined || accountId.length === 0) return undefined;
    const client = clientFromEnv(accountId);
    if (client === null) return undefined;
    const slug = serviceSlugFromUrl(serviceUrl);
    if (slug === null) return undefined;
    const provisionId = generateProvisionId();
    // Try the slug first; fall back to resolving by signup_url host so a
    // custom-named skill (x.ai → "xai-grok") is reachable from its URL.
    let outcome = await client.fetchActiveSkill(slug, provisionId);
    if (outcome.kind !== "found") {
      const host = new URL(serviceUrl).hostname.toLowerCase().replace(/^www\./, "");
      outcome = await client.fetchSkillByHost(host, provisionId);
    }
    return outcome.kind === "found" ? renderSkillHint(outcome.result.skill) : undefined;
  } catch {
    return undefined;
  }
}

// Verified success → synthesize the run into a pending-review skill and publish
// it so the next provision of this service gets a hint. The registry gates
// activation on the verifier replay, so this upload is best-effort: every
// outcome is recorded in the finish_task result trail, nothing is thrown.
async function autoPromoteProvision(sessionId: string): Promise<string> {
  try {
    const promoted = await captureAndPromoteSession(sessionId);
    if (promoted.kind === "skipped") return `skipped:${promoted.reason}`;
    if (promoted.kind !== "ok") {
      // Surface the rejection DETAIL (e.g. the ZodError for schema_invalid), not
      // just the kind — a bare "rejected:schema_invalid" is undiagnosable.
      const detail =
        "detail" in promoted && typeof promoted.detail === "string"
          ? ` — ${promoted.detail.replace(/\s+/g, " ").slice(0, 400)}`
          : "";
      return `rejected:${promoted.error_kind ?? "unknown"}${detail}`;
    }
    const accountId = await resolveAccountId();
    if (accountId === undefined || accountId.length === 0) return "produced:no_account";
    const client = clientFromEnv(accountId);
    if (client === null) return "produced:no_registry";
    let signature: string;
    try {
      signature = signSkillForPublish(promoted.skill).signature;
    } catch {
      // No signing key — the registry ignores the signature (the verifier is
      // the trust signal), so a valid-shaped base64url placeholder is accepted.
      signature = "A".repeat(86);
    }
    const res = await client.publishSkill(promoted.skill, signature);
    return res.kind === "ok" ? `published:${res.status}` : `publish_failed:${res.reason}`;
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

// replay-serve-live-domainlock — after `operate_recipe_save` writes a recipe
// locally, best-effort PUBLISH it to the shared registry so the NEXT
// install to visit this (verb, eTLD+1) can immediately reuse it — a
// recipe serves live the moment the registry accepts it; there is no
// candidate/promotion tier. What stands between this write and steering
// another user's browser is the domain-lock + share-eligibility gates
// (both re-checked server-side; see routes/recipes.ts). Never fails the
// local save: every outcome (including "not eligible to share") is just a
// status string in the tool's result trail. The eligibility gate
// (isRecipeShareEligible) and domain-lock (recipeDomainLockViolations) run
// inside publishRecipe — this function never second-guesses them.
export async function publishRecipeToRegistry(file: string): Promise<string> {
  try {
    const recipe = await readRecipeFromFile(file);
    const accountId = await resolveAccountId();
    if (accountId === undefined || accountId.length === 0) return "skipped:no_account";
    const client = clientFromEnv(accountId);
    if (client === null) return "skipped:no_registry";
    const outcome = await client.publishRecipe(recipe);
    if (outcome.kind === "ok") return `published:${outcome.key}`;
    if (outcome.kind === "not_share_eligible") {
      return `not_shared:${outcome.reasons.join("; ").slice(0, 300)}`;
    }
    return `unavailable:${outcome.reason}`;
  } catch (err) {
    return `error:${err instanceof Error ? err.message : String(err)}`;
  }
}

// replay-serve-live-domainlock — the cross-user reuse path. Local storage
// stays the primary, zero-latency lookup (unchanged single-user behavior);
// only on a LOCAL miss do we ask the shared registry, so an install with
// its own recipe never pays a network round trip it didn't have before.
// The registry returns whatever was last written for the key — safety
// against a tampered/malicious shared recipe comes from the domain-lock
// re-checked at replay time (see recipeDomainLockViolationForReplay below), not
// from a vetting step before the fetch. A registry miss or an unreachable
// registry re-throws the ORIGINAL local error so the caller's existing
// cold-start fallback is untouched.
export async function resolveRecipeForTask(
  verb: OperatorVerb,
  serviceUrl: string,
): Promise<OperatorRecipe> {
  try {
    return await readRecipeForTask(verb, serviceUrl);
  } catch (localErr) {
    const accountId = await resolveAccountId();
    if (accountId === undefined || accountId.length === 0) throw localErr;
    const client = clientFromEnv(accountId);
    if (client === null) throw localErr;
    const domain = operatorRecipeDomain(serviceUrl);
    const outcome = await client.fetchRecipe(verb, domain, generateProvisionId());
    if (outcome.kind !== "found") throw localErr;
    return outcome.result.recipe;
  }
}

// replay-per-leg-signature — the checkout leg's own independent resolution
// path: local first (same zero-latency-on-hit shape as resolveRecipeForTask
// above), then the shared registry, keyed by the LIVE page's field-name-set
// signature instead of domain. Returns null (not a throw) on a total miss —
// the caller degrades to cold driving for this leg only, same as any other
// cache_miss, never a task-ending error.
export async function resolveCheckoutLegRecipe(
  verb: OperatorVerb,
  signature: string,
): Promise<OperatorRecipe | null> {
  try {
    return await readRecipeForCheckoutShape(verb, signature);
  } catch {
    const accountId = await resolveAccountId();
    if (accountId === undefined || accountId.length === 0) return null;
    const client = clientFromEnv(accountId);
    if (client === null) return null;
    const outcome = await client.fetchRecipe(
      verb,
      checkoutShapeKey(signature),
      generateProvisionId(),
    );
    return outcome.kind === "found" ? outcome.result.recipe : null;
  }
}

// replay-serve-live-domainlock — replay-time re-check of the same hard
// domain-lock the registry enforces at write time (recipeDomainLockViolations
// in @trusty-squire/recipe-schema). Defense in depth: covers a locally-
// tampered file, a stale registry that skipped the check, or a recipe
// fetched before this enforcement shipped. Returns null when clean, or a
// human-readable reason when the recipe's resolved entry or any declared
// allowed_hosts entry would leave its own eTLD+1. Checkout-shape recipes have
// no entry or allowed hosts to check here; their field-only restriction is
// enforced at write time and again while each replay step executes.
function recipeDomainLockViolationForReplay(
  recipe: OperatorRecipe,
  entryUrl: string,
): string | null {
  if (recipe.domain === undefined || isCheckoutShapeKey(recipe.domain)) return null;
  if (!isSameRecipeDomain(entryUrl, recipe.domain)) {
    return `entry "${entryUrl}" is outside the recipe's own domain "${recipe.domain}"`;
  }
  const badHost = recipe.allowed_hosts.find((host) => !isSameRecipeDomain(host, recipe.domain!));
  if (badHost !== undefined) {
    return `allowed_hosts entry "${badHost}" is outside the recipe's own domain "${recipe.domain}"`;
  }
  return null;
}

const startSchema = z.object({
  service_url: z.string().url(),
  // Multi-app operate tasks declare every host they span up front (GCP Console
  // + Firebase + the user's app). Alias of extra_allowed_hosts; both seed
  // source "start". A single-service signup passes neither.
  allowed_hosts: z.array(z.string().min(1).max(120)).max(20).optional(),
  extra_allowed_hosts: z.array(z.string().min(1).max(120)).max(10).optional(),
  // Operate tasks that act AS the user (drive a gated app on an existing
  // account) set this so start fails closed to a connect hand-back if no live
  // Google session exists — rather than driving into a mid-task login wall.
  require_live_identity: z.boolean().optional(),
});

const OBSERVE_DELTA_CONTRACT =
  "Compact observations carry their elements in `el_table`: a TAB-delimited table whose FIRST line is the " +
  "header (tab-joined column names, a subset of ref,label,tag,role,type,value_len,checked,href,testId," +
  "topmost,occluded_by, always starting ref,label,tag) and each following line is ONE element (tab-joined " +
  "cells in header order). An empty cell = that field is absent for that element; value_len is a number, " +
  "checked/topmost are true/false; a tab, newline, carriage-return or backslash inside a cell is " +
  "backslash-escaped (\\t \\n \\r \\\\). el_table is absent when the emit has no element rows. " +
  "stable refs remain reusable across observes while their controls still exist. " +
  "The first observe, a URL change, or high churn returns delta:false as a full resync: discard the prior " +
  "element map and rebuild it from this el_table (or from snapshot_file — the table may omit collapsed " +
  "chrome links, which the file keeps); a delta:false with NO snapshot_file already has the complete, " +
  "uncollapsed set in el_table (a persistence-fallback response) — reset from it directly. " +
  "Only when delta:true, el_table lists ONLY the changed elements: upsert them by ref, delete refs listed " +
  "in removed, and retain the remaining elements counted by unchanged. text_unchanged:true means reuse the " +
  "prior text because text is empty. snapshot_file points to the complete current snapshot (all elements, " +
  "with path). An empty delta (no el_table) means nothing changed, not an empty page. " +
  'detail:"full" instead returns the legacy `elements` JSON array (every field), never el_table. ' +
  "If a control you can see in `text`/the screenshot has NO row in el_table (a bare unlabeled clickable " +
  'div — e.g. some SPA "Add To Cart" buttons), it has no ref: click it with operate_act click/js_click ' +
  'target=`text="…"` or `css=…` (see operate_act). `click` respects actionability and throws if an overlay ' +
  "intercepts; dismiss the overlay or deliberately use `js_click`, which directly dispatches through a " +
  "transparent overlay. ";

export const provisionStartTool: Tool<z.infer<typeof startSchema>> = {
  name: "operate_start",
  description:
    "Begin an interactive provisioning session: opens a scoped browser on the " +
    "user's machine at service_url and returns the initial compact observation " +
    "{session_id, url, text, el_table, delta, snapshot_file}. " +
    OBSERVE_DELTA_CONTRACT +
    "YOU are the planner — read the observation, then drive the signup with " +
    'operate_act, re-read with operate_observe, and call operate_act { kind: "extract" } ' +
    "when you reach the credentials. Always operate_finish when done. The " +
    "browser is domain-scoped to the target + its identity providers. If the " +
    "registry knows this service, the first observation includes a `hint` — the " +
    "route (login method, where the key lives, how many credentials). Read it and " +
    "drive toward it; fall back to your own judgment if the live page diverges.",
  inputSchema: startSchema,
  jsonInputSchema: {
    type: "object",
    required: ["service_url"],
    properties: {
      service_url: { type: "string" },
      allowed_hosts: { type: "array", items: { type: "string" } },
      extra_allowed_hosts: { type: "array", items: { type: "string" } },
      require_live_identity: { type: "boolean" },
    },
  },
  async handler(args, api) {
    const hint = await resolveRouteHint(args.service_url);
    const extra = [...(args.allowed_hosts ?? []), ...(args.extra_allowed_hosts ?? [])];
    const consentInboxRead = await readInboxConsent();
    return await startProvisionSession({
      serviceUrl: args.service_url,
      consentInboxRead,
      ...(extra.length > 0 ? { extraAllowedHosts: extra } : {}),
      ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
      ...(hint !== undefined ? { hint } : {}),
      // Thread the api-client so the captcha gate can spend a vaulted 2Captcha key.
      ...(api !== null ? { api } : {}),
    });
  },
};

const observeSchema = z.object({
  session_id: z.string().min(1),
  // Payload verbosity. Default "compact" (stable-ref element/text deltas plus a
  // complete snapshot pointer). Pass "full" for the legacy
  // screen+accessibility+full-field payload on a genuinely ambiguous step.
  detail: z.enum(["compact", "full"]).optional(),
});

export const provisionObserveTool: Tool<z.infer<typeof observeSchema>> = {
  name: "operate_observe",
  description:
    "Re-read the current page of a provisioning session. DEFAULT is a COMPACT " +
    "payload whose elements ride in `el_table` (a tab-delimited table; each row's " +
    "stable `ref` is the operate_act.target) with compact label/role/href/value_len " +
    "columns and `frame_origin` on child-frame controls; ordinary same- and " +
    "cross-origin frames are included, while known captcha challenge frames stay " +
    "behind the dedicated captcha flow. Path is retained only in snapshot_file, " +
    "and redundant screen/accessibility trees are omitted. " +
    OBSERVE_DELTA_CONTRACT +
    "Pass " +
    'detail:"full" for the legacy screen+accessibility+full-field payload on a ' +
    "genuinely ambiguous step.",
  inputSchema: observeSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      detail: { type: "string", enum: ["compact", "full"] },
    },
  },
  async handler(args) {
    return await observe(args.session_id, args.detail ?? "compact");
  },
};

// Shared credential destination shape. Both operate_act(kind:"extract") and
// the legacy operate_extract alias validate and execute this exact contract.
// The credentials terminal also reuses it below.
const storeShape = z.object({
  service: z.string().min(1).max(120),
  label: z.string().min(1).max(60).optional(),
  env_var_suggestion: z.string().min(1).max(120).optional(),
  type: z.string().min(1).max(60).optional(),
  // Explicit egress hosts: where this key may LATER be sent by the proxy.
  // Read them off the API base URL the page/SDK snippet shows — a grounded
  // read, not a guess. Unioned with the service-default + start/auto_widen
  // scope (never mid_session task scope). Omit for a single-service key.
  egress_hosts: z.array(z.string().min(1).max(253)).max(10).optional(),
  auth_shape: z
    .string()
    .max(120)
    .regex(/^(bearer|header:.+|query:.+)$/, "auth_shape must be bearer|header:<name>|query:<param>")
    .optional(),
});
type StoreSpec = z.infer<typeof storeShape>;

const storeJsonProps = {
  service: { type: "string" },
  label: { type: "string" },
  env_var_suggestion: { type: "string" },
  type: { type: "string" },
  egress_hosts: { type: "array", items: { type: "string" } },
  auth_shape: { type: "string" },
} as const;

const formSelectionsSchema = z
  .record(z.string().min(1).max(200), z.string().min(1).max(4096))
  .refine((value) => Object.keys(value).length > 0, "Provide at least one selection")
  .refine((value) => Object.keys(value).length <= 12, "At most 12 selections per call");

interface CartAddArgs {
  session_id: string;
  product_identity: string;
  options_hash: string;
  idempotency_key: string;
}

interface FormSelectManyArgs {
  session_id: string;
  selections: Record<string, string>;
}

interface ExtractArgs {
  session_id: string;
  into_slot?: string | undefined;
  secret_label?: string | undefined;
  store?: StoreSpec | undefined;
}

interface CaptchaArgs {
  session_id: string;
}

interface AwaitVerificationArgs {
  session_id: string;
  sender?: string | undefined;
  into_slot?: string | undefined;
  grant_inbox_consent?: boolean | undefined;
}

interface LoginPrepareSignupArgs {
  session_id: string;
  login_slot?: string | undefined;
  password_slot?: string | undefined;
  password_length?: number | undefined;
}

interface LoginStoreSignupArgs {
  session_id: string;
  service: string;
  login_slot?: string | undefined;
  password_slot?: string | undefined;
  label?: string | undefined;
  signin_url?: string | undefined;
  login_hosts: string[];
}

interface LoginLoadSavedArgs {
  session_id: string;
  reference?: string | undefined;
  service?: string | undefined;
  fields: string[];
  slot_prefix: string;
}

const actSchema = z
  .object({
    session_id: z.string().min(1),
    kind: z.enum([
      "click",
      "js_click",
      "type",
      "select",
      "set_phone_country",
      "goto",
      "press",
      "oauth_login",
      "oauth_click",
      "oauth_settle",
      "allow_host",
      "type_secret",
      "scroll",
      "upload",
      "cart_add",
      "select_many",
      "extract",
      "solve_captcha",
      "await_verification",
      "login_prepare_signup",
      "login_store_signup",
      "login_load_saved",
    ]),
    target: z.string().min(1).max(200).optional(),
    text: z.string().max(4096).optional(),
    // set_phone_country supports phone-local native country <select> controls.
    country: z.string().min(1).max(60).optional(),
    // upload: absolute path to a LOCAL file to attach to `target` (the upload
    // button/menu-item, or the file <input>).
    path: z.string().min(1).max(4096).optional(),
    url: z.string().url().optional(),
    key: z.string().min(1).max(40).optional(),
    // allow_host: a bare hostname to cross into mid-session.
    host: z.string().min(1).max(253).optional(),
    // type_secret: the sealed slot whose value to type into `target`.
    slot: z.string().min(1).max(60).optional(),
    product_identity: z.string().trim().min(1).max(500).optional(),
    options_hash: z.string().trim().min(1).max(128).optional(),
    idempotency_key: z.string().trim().min(1).max(256).optional(),
    selections: formSelectionsSchema.optional(),
    into_slot: z.string().min(1).max(60).optional(),
    secret_label: z.string().min(1).max(60).optional(),
    store: storeShape.optional(),
    sender: z.string().min(1).max(120).optional(),
    grant_inbox_consent: z.boolean().optional(),
    // login_prepare_signup / login_store_signup: sealed username/password
    // signup slots (never raw values).
    login_slot: z.string().min(1).max(60).optional(),
    password_slot: z.string().min(1).max(60).optional(),
    password_length: z.number().int().min(16).max(64).optional(),
    // login_store_signup: vault the prepared signup as a username_password
    // credential. login_load_saved: fetch an existing one instead.
    service: z.string().min(1).max(120).optional(),
    label: z.string().min(1).max(120).optional(),
    signin_url: z.string().url().optional(),
    login_hosts: z.array(z.string().min(1).max(253)).min(1).max(20).optional(),
    // login_load_saved: which saved credential + which fields to seal.
    reference: z.string().min(1).max(400).optional(),
    fields: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
    slot_prefix: z.string().min(1).max(60).optional(),
    provenance: RecipeHoleSchema.shape.hole.optional(),
    replay_step_index: z.number().int().min(0).optional(),
    replay_hole: RecipeHoleSchema.shape.hole.optional(),
    // scroll: which way to move the viewport (default "down").
    direction: z.enum(["down", "up", "bottom", "top"]).optional(),
    // How much perception to return AFTER the action (the same ladder as
    // operate_observe, plus "none"). "none" = a minimal ack (action ran; no page
    // dump) for chained fills — call operate_observe before the next ref-targeted
    // act. "full" = the legacy payload. Default "compact".
    detail: z.enum(["none", "compact", "full"]).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.product_identity === undefined) !== (value.options_hash === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "product_identity and options_hash must be provided together",
      });
    }
    const requiredByKind: Record<string, readonly string[]> = {
      click: ["target"],
      js_click: ["target"],
      type: ["target"],
      oauth_login: ["target"],
      oauth_click: ["target"],
      select: ["target", "text"],
      set_phone_country: ["country"],
      goto: ["url"],
      press: ["key"],
      allow_host: ["host"],
      type_secret: ["slot", "target"],
      upload: ["target", "path"],
      cart_add: ["product_identity", "options_hash", "idempotency_key"],
    };
    const actionValue = value as Record<string, unknown>;
    for (const field of requiredByKind[value.kind] ?? []) {
      const supplied = actionValue[field];
      if (typeof supplied !== "string" || supplied.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Required for kind="${value.kind}"`,
        });
      }
    }
    if (value.kind === "select_many" && value.selections === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selections"],
        message: 'Required for kind="select_many"',
      });
    }
    if (value.kind === "login_store_signup") {
      if (value.service === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["service"],
          message: 'Required for kind="login_store_signup"',
        });
      }
      if (value.login_hosts === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["login_hosts"],
          message: 'Required for kind="login_store_signup"',
        });
      }
    }
    if (
      value.kind === "login_load_saved" &&
      value.reference === undefined &&
      value.service === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message: 'kind="login_load_saved" requires one of reference or service',
      });
    }
    if ((value.replay_step_index === undefined) !== (value.replay_hole === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replay_step_index and replay_hole must be provided together",
      });
    }
    if (
      value.replay_hole !== undefined &&
      value.provenance !== undefined &&
      value.replay_hole !== value.provenance
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replay_hole and provenance must identify the same source",
      });
    }
    if (
      value.replay_step_index !== undefined &&
      value.kind !== "type" &&
      value.kind !== "select" &&
      value.kind !== "set_phone_country"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replay repair binding requires a value action",
      });
    }
    const provenance = value.provenance ?? value.replay_hole;
    if (provenance === undefined) return;
    if (
      value.kind !== "type" &&
      value.kind !== "select" &&
      value.kind !== "set_phone_country" &&
      value.kind !== "type_secret"
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "provenance requires a value action" });
    } else if (value.kind === "type_secret" && !/^credential(?:\.|$)/.test(provenance)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "type_secret provenance must be credential",
      });
    } else if (value.kind !== "type_secret" && /^(?:credential|card)(?:\.|$)/.test(provenance)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "credential/card provenance requires type_secret or operate_pay",
      });
    }
  });

const ACTION_KINDS = [
  "click",
  "js_click",
  "type",
  "select",
  "set_phone_country",
  "goto",
  "press",
  "oauth_login",
  "oauth_click",
  "oauth_settle",
  "allow_host",
  "type_secret",
  "scroll",
  "upload",
  "cart_add",
  "select_many",
  "extract",
  "solve_captcha",
  "await_verification",
  "login_prepare_signup",
  "login_store_signup",
  "login_load_saved",
] as const;

type ActionKind = (typeof ACTION_KINDS)[number];

interface ActionRepair {
  example: Record<string, unknown>;
  safe_alternative: string;
}

const manualCardRecovery = " Never enter card values with operate_act; use operate_pay.";

const ACTION_REPAIR_BY_KIND: Partial<Record<ActionKind, ActionRepair>> = {
  cart_add: {
    example: {
      session_id: "<session_id>",
      kind: "cart_add",
      product_identity: "<canonical-product-identity>",
      options_hash: "<selected-options-hash>",
      idempotency_key: "<stable-idempotency-key>",
    },
    safe_alternative:
      "Retry cart_add with the same stable idempotency_key for the same product_identity and options_hash. Do not replace it with click: cart_add reserves the mutation and exact-line post-verifies the cart." +
      manualCardRecovery,
  },
  select_many: {
    example: {
      session_id: "<session_id>",
      kind: "select_many",
      selections: { "Observed field label": "Visible option label" },
    },
    safe_alternative:
      "Retry select_many with selections in the intended order. It selects sequentially, re-observes after each success, and returns partial results; do not replace it with parallel select calls." +
      manualCardRecovery,
  },
  extract: {
    example: {
      session_id: "<session_id>",
      kind: "extract",
      into_slot: "sealed_secret",
      secret_label: "API key",
    },
    safe_alternative:
      "Retry extract after navigating to the credential page. Use into_slot with optional secret_label to seal a value without exposing it, or store with a service to vault it; never put credential values in arguments or seal a still-masked value." +
      manualCardRecovery,
  },
  solve_captcha: {
    example: {
      session_id: "<session_id>",
      kind: "solve_captcha",
    },
    safe_alternative:
      "Retry solve_captcha so the dedicated solver handles the gate. If it returns needs_user, relay the exact remedy and stop driving; do not bypass the gate or keep churning." +
      manualCardRecovery,
  },
  await_verification: {
    example: {
      session_id: "<session_id>",
      kind: "await_verification",
      sender: "service.example",
      into_slot: "otp",
      grant_inbox_consent: false,
    },
    safe_alternative:
      "Retry await_verification with sender scoped to the service and prefer into_slot so the OTP stays sealed. Leave grant_inbox_consent false unless the user explicitly agrees; only retry with grant_inbox_consent:true after that explicit yes." +
      manualCardRecovery,
  },
  login_prepare_signup: {
    example: {
      session_id: "<session_id>",
      kind: "login_prepare_signup",
    },
    safe_alternative:
      "Retry login_prepare_signup to seal the user's captured email and a generated password into session slots, then fill the signup form with type_secret using the returned login/password slots." +
      manualCardRecovery,
  },
  login_store_signup: {
    example: {
      session_id: "<session_id>",
      kind: "login_store_signup",
      service: "<service-name>",
      login_hosts: ["service.example"],
    },
    safe_alternative:
      "Retry login_store_signup with service and login_hosts (the hosts where this login may be filled) after the account is created — it vaults the prepared login_prepare_signup slots server-side." +
      manualCardRecovery,
  },
  login_load_saved: {
    example: {
      session_id: "<session_id>",
      kind: "login_load_saved",
      service: "<service-name>",
    },
    safe_alternative:
      "Retry login_load_saved with reference or service to fetch an allowed saved login and seal its fields into session slots, then fill with type_secret." +
      manualCardRecovery,
  },
};

function actionSchemaRepair(args: unknown, issues: readonly { path: (string | number)[] }[]) {
  const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const kind =
    typeof input.kind === "string" && ACTION_KINDS.includes(input.kind as ActionKind)
      ? (input.kind as ActionKind)
      : undefined;
  const missing = [
    ...new Set(
      issues
        .map((issue) => issue.path[0])
        .filter((field): field is string => typeof field === "string"),
    ),
  ];
  const kindRepair = kind === undefined ? undefined : ACTION_REPAIR_BY_KIND[kind];
  const example =
    kindRepair !== undefined
      ? kindRepair.example
      : kind === "oauth_login"
        ? {
            session_id: "<session_id>",
            kind: "oauth_login",
            target: "@e:<observed-provider-button-ref>",
          }
        : kind === "type_secret"
          ? {
              session_id: "<session_id>",
              kind: "type_secret",
              slot: "sealed_secret",
              target: "@e:<observed-ref>",
            }
          : kind === "select"
            ? {
                session_id: "<session_id>",
                kind: "select",
                target: "@e:<observed-ref>",
                text: "Option label",
              }
            : {
                session_id: "<session_id>",
                kind: "type",
                target: "@e:<observed-ref>",
                text: "Text to enter",
              };
  const safe_alternative =
    kindRepair !== undefined
      ? kindRepair.safe_alternative
      : kind === "type_secret" && missing.includes("slot")
        ? 'First capture the value with operate_act { kind: "extract", into_slot: "sealed_secret" }, then retry with that slot and a ref from operate_observe. Never enter card values with operate_act; use operate_pay.'
        : 'Use kind "type" for text fields or "select" for options, and take target refs from operate_observe. Never enter card values with operate_act; use operate_pay.';
  return {
    error: "invalid_action_arguments",
    ...(typeof input.kind === "string" ? { supplied_kind: input.kind } : {}),
    allowed_kinds: ACTION_KINDS,
    missing,
    example,
    safe_alternative,
  };
}

function buildAction(args: z.infer<typeof actSchema>): ProvisionAction {
  const need = (v: string | undefined, name: string): string => {
    if (v === undefined || v.length === 0) {
      throw new Error(`operate_act kind="${args.kind}" requires "${name}"`);
    }
    return v;
  };
  const replayRepair =
    args.replay_step_index !== undefined && args.replay_hole !== undefined
      ? { replayRepair: { stepIndex: args.replay_step_index, hole: args.replay_hole } }
      : {};
  const provenance = args.provenance ?? args.replay_hole;
  switch (args.kind) {
    case "click":
      return { kind: "click", target: need(args.target, "target") };
    case "js_click":
      return { kind: "js_click", target: need(args.target, "target") };
    case "oauth_click":
      return { kind: "oauth_click", target: need(args.target, "target") };
    case "oauth_login":
      return { kind: "oauth_login", target: need(args.target, "target") };
    case "type":
      return {
        kind: "type",
        target: need(args.target, "target"),
        text: args.text ?? "",
        ...(provenance !== undefined ? { provenance: { hole: provenance } } : {}),
        ...replayRepair,
      };
    case "select":
      return {
        kind: "select",
        target: need(args.target, "target"),
        text: need(args.text, "text"),
        ...(provenance !== undefined ? { provenance: { hole: provenance } } : {}),
        ...replayRepair,
      };
    case "set_phone_country":
      return {
        kind: "set_phone_country",
        country: need(args.country, "country"),
        ...(provenance !== undefined ? { provenance: { hole: provenance } } : {}),
        ...replayRepair,
      };
    case "goto":
      return { kind: "goto", url: need(args.url, "url") };
    case "press":
      return { kind: "press", key: need(args.key, "key") };
    case "oauth_settle":
      return { kind: "oauth_settle" };
    case "allow_host":
      return { kind: "allow_host", host: need(args.host, "host") };
    case "type_secret":
      return {
        kind: "type_secret",
        slot: need(args.slot, "slot"),
        target: need(args.target, "target"),
        ...(args.provenance !== undefined ? { provenance: { hole: args.provenance } } : {}),
      };
    case "scroll":
      return {
        kind: "scroll",
        ...(args.direction !== undefined ? { direction: args.direction } : {}),
      };
    case "upload":
      return { kind: "upload", target: need(args.target, "target"), path: need(args.path, "path") };
    case "cart_add":
    case "select_many":
    case "extract":
    case "solve_captcha":
    case "await_verification":
    case "login_prepare_signup":
    case "login_store_signup":
    case "login_load_saved":
      throw new Error(`operate_act kind="${args.kind}" must use its delegated handler`);
  }
}

async function handleCartAdd(args: CartAddArgs) {
  return await cartAdd(
    args.session_id,
    args.product_identity,
    args.options_hash,
    args.idempotency_key,
  );
}

async function handleFormSelectMany(args: FormSelectManyArgs) {
  return await formSelectMany(args.session_id, args.selections);
}

async function handleExtract(args: ExtractArgs, api: ApiClient | null) {
  const extracted = await extractCredentials(args.session_id);

  // Sealed transfer: capture the primary secret into a session-local slot and
  // return ONLY a masked handle. The value never reaches the host. A later
  // type_secret enters it into another site's form. Mutually exclusive with
  // store (a slotted secret is being shuttled, not vaulted, in this call).
  if (args.into_slot !== undefined) {
    const values = extracted.credentials;
    // A still-masked display (Google's OAuth secret shows "GOCSPX-••••" with a
    // copy button) must NOT be sealed — the slot would hold junk. Reject any
    // value with mask glyphs (canonical isMaskedDisplay) or the truncated-capture
    // marker, and prefer a full value over the masked api_key when the page has both.
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates = Object.entries(values).filter(
      ([k, v]) =>
        !k.endsWith("_truncated") && typeof v === "string" && v.length >= 8 && !isMaskedDisplay(v),
    );
    // When the page shows several credentials (Google's client ID + secret),
    // a secret_label picks the right one by field name; otherwise take the
    // first full value. Falling back avoids a hard fail when the label misses.
    const wantKey = args.secret_label !== undefined ? norm(args.secret_label) : null;
    const matched =
      wantKey !== null ? candidates.find(([k]) => norm(k).includes(wantKey)) : undefined;
    const full = (matched ?? candidates[0])?.[1];
    if (typeof full !== "string" || full.length === 0) {
      return {
        session_id: extracted.session_id,
        url: extracted.url,
        candidate_count: extracted.candidate_count,
        sealed: false,
        slot: null,
        blocked_reason:
          "the secret is still masked/hidden — reveal it first (click the " +
          'show/reveal/copy control near the key), then operate_act { kind: "extract" } again',
      };
    }
    const handle = stashSecretSlot(args.session_id, args.into_slot, full);
    // Strip raw credential VALUES from the response — host gets the handle only.
    return {
      session_id: extracted.session_id,
      url: extracted.url,
      candidate_count: extracted.candidate_count,
      sealed: true,
      slot: handle,
      ...(extracted.blocked_reason !== undefined
        ? { blocked_reason: extracted.blocked_reason }
        : {}),
    };
  }

  if (args.store === undefined || Object.keys(extracted.credentials).length === 0) {
    return extracted;
  }
  if (api === null) {
    throw new Error(
      'operate_act { kind: "extract" } store requires an active Trusty Squire session',
    );
  }
  const stored = await persistExtracted(args.session_id, extracted.credentials, args.store, api);
  return storedExtractResult(extracted, stored);
}

async function handleCaptcha(args: CaptchaArgs) {
  return await captchaGate(args.session_id);
}

async function handleAwaitVerification(args: AwaitVerificationArgs) {
  return await awaitVerification(args.session_id, {
    ...(args.sender !== undefined ? { sender: args.sender } : {}),
    ...(args.into_slot !== undefined ? { intoSlot: args.into_slot } : {}),
    ...(args.grant_inbox_consent === true ? { grantConsent: true } : {}),
  });
}

export const provisionActTool: Tool<z.infer<typeof actSchema>> = {
  name: "operate_act",
  description:
    "Take one action in a provisioning session, then return the resulting " +
    "observation. kinds: click (target=element ref, preferably an el_table row's ref), " +
    "type (target + text; model-supplied card-number-shaped text is refused — card payment " +
    "must use operate_pay, which fills a vaulted card without exposing it to the model), " +
    "" +
    "TARGET FALLBACK (clicking or typing only) — when a control you can SEE (in the " +
    "observation text or screenshot) has NO ref in el_table (a bare click-handler " +
    '<div> with no role/label, e.g. a SPA "Add To Cart"), pass target as a locator ' +
    'instead of a ref: `text="Add To Cart"` (a matching clickable or typeable ' +
    "element, case-insensitive, hidden descendants ignored, open shadow roots " +
    "pierced) or `css=<selector>` (a raw CSS selector). Only for click / js_click / " +
    "type / type_secret. Resolved against the LIVE main document and ordinary " +
    "child frames, not el_table, so it reaches controls the inventory never emitted. It " +
    "refuses an ambiguous match (returns the candidate texts — narrow with an " +
    "exact text= or a css= selector). `click` is actionability-checked and throws " +
    "if an overlay intercepts; dismiss the overlay or deliberately use `js_click`, " +
    "the explicit direct DOM dispatch that fires through a transparent overlay. " +
    "Prefer a real ref when one exists; reach for " +
    "text=/css= only when none does. " +
    "Observed child-frame refs and locator matches retain their frame origin. " +
    "Same-registrable-domain frames are reachable; other frame actions must pass " +
    "the goto/allow_host domain scope, opaque frames are refused, and type_secret " +
    "never targets a cross-domain frame. Frame-scoped select supports native " +
    "<select> controls only; drive a custom framed widget with click. " +
    "upload/oauth_click/oauth_login refuse frame refs. " +
    "select (target + text — pick an option in a native <select> or custom listbox " +
    "by its visible text, e.g. a country/state dropdown that `type` can't drive), " +
    "set_phone_country (country — set the dial-code country on a phone field's " +
    "native <select>, including react-phone-number-input's hidden country select; " +
    "other phone widget families are not yet supported and throw; no target needed), " +
    "goto (url — domain-scoped), press (key, e.g. Enter), oauth_login (target — " +
    "the ONLY action for a Login/Continue with provider button: it runs the OAuth " +
    "popup/redirect atomically, retains the product tab if the provider closes its " +
    "window, and returns the post-login observation in this call), oauth_click and " +
    "oauth_settle are legacy replay compatibility actions; do not use them for new " +
    "operator work, " +
    "allow_host (host — cross into another app's domain mid-task, e.g. from the " +
    "GCP console into Firebase), type_secret (slot + target — type a secret you " +
    'captured into a sealed slot via operate_act { kind: "extract", into_slot: "<slot>" } into a field ' +
    "on the current site; the value never leaves the browser), scroll (direction " +
    "down/up/bottom/top, default down — reveal below-the-fold controls on a long " +
    "form, then operate_observe to pick up the newly-visible elements), " +
    "upload (target + path — attach a LOCAL file: target is the visible upload " +
    "button/menu-item (or the file <input>), path is an absolute local file " +
    "path. The bot sets the file via the browser's file chooser, so no OS dialog " +
    "is driven and no API credential is needed — it uses the session you're " +
    "already signed into). " +
    "cart_add (product_identity + options_hash + idempotency_key — reserve an " +
    "idempotent cart mutation, exact-line post-verify it, and return its postcondition), " +
    "select_many (ordered selections map — select sequentially, re-observe after " +
    "each success, and retain partial results), extract (into_slot/secret_label/store — " +
    "reveal masked keys and extract credentials from the current page, sealed slot or vaulted), " +
    "solve_captcha (detect and drive the in-session captcha gate; settled=false carries a " +
    "needs_user{gate,message,remedy} — FAIL FAST and relay it to the user), " +
    "await_verification (sender/into_slot/grant_inbox_consent — read the user's OWN inbox " +
    "through their signed-in browser session for an email verification code/link, sealed " +
    "into a slot with into_slot). Sealed username/password login lifecycle, never exposing raw " +
    "values: login_prepare_signup (login_slot/password_slot/password_length — seal the user's " +
    "captured email and a generated strong password into session slots; fill the signup form " +
    "with type_secret using the returned slots), login_store_signup (service + login_hosts, " +
    "optional label/signin_url — after the account is created, vault the prepared signup slots " +
    "as a username_password credential so the user can sign back in; the signin_url host, if " +
    "given, is always included in login_hosts), login_load_saved (reference or service, " +
    "optional fields/slot_prefix — for a sign-in page, fetch a saved username/password " +
    "credential only if the current browser host is allowed for login, then seal its fields " +
    "into session slots; fill with type_secret). " +
    "For type/select/set_phone_country, pass provenance when the value came from a " +
    "Squire-known address, contact, product_query, or quantity input; type_secret and " +
    "operate_pay record credential and card provenance from their sealed sources. " +
    "When repairing a replay fallback field, pass its replay_step_index and replay_hole. " +
    "Stable target refs remain reusable while their element exists. If an @e: ref is stale, " +
    "the response is {status:target_stale, replacement_candidates, retry_policy:do_not_retry_old_ref}; " +
    "call operate_observe and choose a new ref instead of retrying the old one. " +
    'detail (default "compact") controls the returned payload: "none" skips it ' +
    "entirely for chained fills (then operate_observe before the next ref action), " +
    '"full" returns the legacy screen+accessibility payload. ' +
    "For legible product/variant hints on a cart-affecting action, pass product_identity and options_hash together; returned checkout_state is best-effort informational state and never a payment charge input. " +
    OBSERVE_DELTA_CONTRACT,
  inputSchema: actSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "kind"],
    properties: {
      session_id: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "click",
          "js_click",
          "type",
          "select",
          "set_phone_country",
          "goto",
          "press",
          "oauth_login",
          "oauth_click",
          "oauth_settle",
          "allow_host",
          "type_secret",
          "scroll",
          "upload",
          "cart_add",
          "select_many",
          "extract",
          "solve_captcha",
          "await_verification",
          "login_prepare_signup",
          "login_store_signup",
          "login_load_saved",
        ],
      },
      target: { type: "string" },
      text: { type: "string" },
      country: { type: "string" },
      path: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
      host: { type: "string" },
      slot: { type: "string" },
      product_identity: { type: "string", minLength: 1 },
      options_hash: { type: "string", minLength: 1 },
      idempotency_key: { type: "string", minLength: 1 },
      selections: {
        type: "object",
        minProperties: 1,
        maxProperties: 12,
        additionalProperties: { type: "string" },
        description: "Map each observed field label or @e: ref to its visible option text.",
      },
      into_slot: { type: "string" },
      secret_label: { type: "string" },
      store: {
        type: "object",
        required: ["service"],
        properties: storeJsonProps,
      },
      sender: { type: "string" },
      grant_inbox_consent: { type: "boolean" },
      login_slot: { type: "string" },
      password_slot: { type: "string" },
      password_length: { type: "number" },
      service: { type: "string" },
      label: { type: "string" },
      signin_url: { type: "string" },
      login_hosts: { type: "array", items: { type: "string" } },
      reference: { type: "string" },
      fields: { type: "array", items: { type: "string" } },
      slot_prefix: { type: "string" },
      provenance: {
        type: "string",
        pattern:
          "^(?:address|contact|credential|card)(?:\\.[a-zA-Z0-9_-]+)?$|^(?:product_query|quantity)$",
      },
      replay_step_index: { type: "integer", minimum: 0 },
      replay_hole: {
        type: "string",
        pattern:
          "^(?:address|contact|credential|card)(?:\\.[a-zA-Z0-9_-]+)?$|^(?:product_query|quantity)$",
      },
      direction: { type: "string", enum: ["down", "up", "bottom", "top"] },
      detail: { type: "string", enum: ["none", "compact", "full"] },
    },
  },
  schemaRepair: actionSchemaRepair,
  async handler(args, api) {
    switch (args.kind) {
      case "cart_add":
        return await handleCartAdd(args as CartAddArgs);
      case "select_many":
        return await handleFormSelectMany(args as FormSelectManyArgs);
      case "extract":
        return await handleExtract(args, api);
      case "solve_captcha":
        return await handleCaptcha(args);
      case "await_verification":
        return await handleAwaitVerification(args);
      case "login_prepare_signup":
        return await handlePrepareLogin(args as LoginPrepareSignupArgs);
      case "login_store_signup":
        return await handleStoreLogin(args as LoginStoreSignupArgs, api);
      case "login_load_saved":
        return await handleSealVaultCredential(
          {
            ...(args as LoginLoadSavedArgs),
            fields: args.fields ?? ["login", "password"],
            slot_prefix: args.slot_prefix ?? "vault",
          },
          api,
        );
    }
    // Keep the defense-in-depth guard in act() for internal/replay callers,
    // while this public tool surface makes the safe recovery explicit at the
    // exact point a small model tried a forbidden manual PAN entry.
    if (args.kind === "type") {
      const reason = manualCardEntryBlockReason(args.text ?? "");
      if (reason !== null) {
        return {
          status: "manual_card_entry_refused",
          reason,
          safe_alternative: "operate_pay",
          missing_prerequisite: "verified_cart_total",
        };
      }
    }
    try {
      return await act(
        args.session_id,
        buildAction(args),
        args.detail ?? "compact",
        args.product_identity !== undefined && args.options_hash !== undefined
          ? { productIdentity: args.product_identity, optionsHash: args.options_hash }
          : undefined,
      );
    } catch (err) {
      if (err instanceof TargetStaleError) return err.result;
      throw err;
    }
  },
};

// The former standalone tool objects in the following sections are NOT part of
// the default MCP surface (they were dropped from OPERATE_TOOLS in the
// bare-essentials cut). They remain as internal implementation objects: each
// `handler` is the exact function operate_act's matching `kind` calls, so tests
// exercise the same code path without a second live registration. See
// OPERATE_TOOLS at the bottom of this file for what a host agent actually sees.
const cartAddSchema = z.object({
  session_id: z.string().min(1),
  product_identity: z.string().trim().min(1).max(500),
  options_hash: z.string().trim().min(1).max(128),
  idempotency_key: z.string().trim().min(1).max(256),
});

export const operateCartAddTool: Tool<z.infer<typeof cartAddSchema>> = {
  name: "operate_cart_add",
  description:
    "Idempotently add the current product to cart. Pass the canonical product_identity, " +
    "the selected-variant options_hash, and a stable idempotency_key. The tool post-verifies " +
    "the cart state and returns checkout_state, cart_delta, and canonical cart_url. Retrying the " +
    "same product/variant never clicks again: it returns already_in_cart with cart_delta '0'. " +
    "checkout_state is a best-effort informational hint; operate_pay independently verifies the charge total.",
  inputSchema: cartAddSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "product_identity", "options_hash", "idempotency_key"],
    properties: {
      session_id: { type: "string" },
      product_identity: { type: "string", minLength: 1 },
      options_hash: { type: "string", minLength: 1 },
      idempotency_key: { type: "string", minLength: 1 },
    },
  },
  annotations: { readOnlyHint: false, idempotentHint: true },
  handler: handleCartAdd,
};

const formSelectManySchema = z.object({
  session_id: z.string().min(1),
  // A label/ref → visible option map. Labels deliberately match the existing
  // select targeting grammar, while refs remain useful when labels collide.
  selections: formSelectionsSchema,
});

export const operateFormSelectManyTool: Tool<z.infer<typeof formSelectManySchema>> = {
  name: "operate_form_select_many",
  description:
    "Select several related form options sequentially from a label/ref-to-option map. " +
    "Selections run in order; after every successful selection the browser is re-observed " +
    "before the next one resolves, so variant changes cannot poison later refs. Each field " +
    "reports selected or failed independently; successful selections are not rolled back when " +
    "another field fails. Returns the per-field results plus the final observation. Use this for " +
    "coupled variant or shipping selectors instead of parallel operate_act select calls.",
  inputSchema: formSelectManySchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "selections"],
    properties: {
      session_id: { type: "string" },
      selections: {
        type: "object",
        minProperties: 1,
        maxProperties: 12,
        additionalProperties: { type: "string" },
        description: "Map each observed field label or @e: ref to its visible option text.",
      },
    },
  },
  handler: handleFormSelectMany,
};

const extractSchema = z.object({
  session_id: z.string().min(1),
  into_slot: z.string().min(1).max(60).optional(),
  secret_label: z.string().min(1).max(60).optional(),
  store: storeShape.optional(),
});

export const provisionExtractTool: Tool<z.infer<typeof extractSchema>> = {
  name: "operate_extract",
  description:
    "Reveal masked keys and extract credentials from the current page: returns " +
    "{credentials, candidate_count, blocked_reason?}. credentials may include " +
    "`api_key` (or `api_key_truncated` if only a masked display was reachable) " +
    "plus named fields for multi-credential services. Pass `store` to immediately " +
    "save the extracted credential into the Trusty Squire vault with the session's " +
    "observed hosts as allowed_hosts seed; when `store` is used, the response omits " +
    "credential values and returns only vault metadata. If `blocked_reason` is set, " +
    "the page is a login wall / anti-bot interstitial with NO credential present " +
    "(do not treat the empty result as a real key) — drive an interactive login " +
    "or hand back to the user. Call when you have navigated to the keys page. " +
    "With `into_slot`, a still-masked value is refused (reveal it first); pass " +
    '`secret_label` (e.g. "client secret") to pick the right one when the page ' +
    "shows several credentials.",
  inputSchema: extractSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      into_slot: { type: "string" },
      secret_label: { type: "string" },
      store: {
        type: "object",
        required: ["service"],
        properties: {
          service: { type: "string" },
          label: { type: "string" },
          env_var_suggestion: { type: "string" },
          type: { type: "string" },
          egress_hosts: { type: "array", items: { type: "string" } },
          auth_shape: { type: "string" },
        },
      },
    },
  },
  handler: handleExtract,
};

const captchaSchema = z.object({ session_id: z.string().min(1) });

export const provisionCaptchaGateTool: Tool<z.infer<typeof captchaSchema>> = {
  name: "operate_captcha_gate",
  description:
    "Detect a captcha and drive the in-session captcha gate: returns {found, variant, " +
    "settled, needs_user?}. The gate attempts visible checkbox widgets and invisible " +
    "reCAPTCHA execution itself, then requires a real response token before " +
    "settled=true. settled=false means it couldn't be cleared and carries a " +
    "`needs_user` {gate, message, remedy} — FAIL FAST: relay that exact remedy to " +
    "the user and stop driving, don't keep churning. gate='captcha_solver' means " +
    "set up 2Captcha in settings; gate='captcha_wall' means a proxy or manual signup.",
  inputSchema: captchaSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: { session_id: { type: "string" } },
  },
  handler: handleCaptcha,
};

const verifySchema = z.object({
  session_id: z.string().min(1),
  sender: z.string().min(1).max(120).optional(),
  into_slot: z.string().min(1).max(60).optional(),
  grant_inbox_consent: z.boolean().optional(),
});

export const provisionAwaitVerificationTool: Tool<z.infer<typeof verifySchema>> = {
  name: "operate_await_verification",
  description:
    "Read the user's OWN inbox through their signed-in browser session (no IMAP, " +
    "no mail token) to complete email verification: returns {found, code, link, " +
    "source_from, needs_user?}. ALWAYS pass `sender` (e.g. 'brave.com') to scope " +
    "the search — a no-sender search can grab a code from an UNRELATED email; the " +
    "returned `source_from` is the sender the code/link came from, so verify it " +
    "matches the service before using the code. On found=true, type the code with " +
    "operate_act, or — for a magic/verification LINK — `goto` the returned link " +
    "directly (do NOT click it inside Gmail; Gmail opens external links in a new " +
    "tab that won't drive the session). PREFER passing " +
    "`into_slot` (e.g. 'otp'): the code is sealed into a slot (you get a masked " +
    "handle, not the digits) and you enter it with operate_act{type_secret, slot} " +
    "— the code never round-trips through you. On found=false a `needs_user` " +
    "object is returned (wall='verification_code') — the code came by SMS/" +
    "authenticator or hasn't arrived: ASK THE USER for it, then type it with " +
    "operate_act and continue. The session stays live; this is a resumable " +
    "hand-back, not a failure. Scoped search-and-extract — reads only the matching " +
    "recent mail, never the whole inbox. If a needs_user(verification_code) says " +
    "inbox reading isn't consented, ask the user; on an explicit yes retry with " +
    "grant_inbox_consent:true.",
  inputSchema: verifySchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      sender: { type: "string" },
      into_slot: { type: "string" },
      grant_inbox_consent: { type: "boolean" },
    },
  },
  handler: handleAwaitVerification,
};

// Vault-store an extracted credential. Shared by extract + the credentials
// terminal so the stored record is byte-identical regardless of entry point.
export interface StoredCredentialMetadata {
  reference: string;
  service: string;
  label: string | undefined;
  field_names: string[];
  allowed_hosts: string[];
  updated: boolean;
}

async function persistExtracted(
  sessionId: string,
  credentials: Record<string, string>,
  store: StoreSpec,
  api: ApiClient,
): Promise<StoredCredentialMetadata> {
  const observedHosts = [
    ...new Set([...(store.egress_hosts ?? []), ...observedHostsForSession(sessionId)]),
  ];
  const singleValue = credentials.api_key;
  const storeInput =
    typeof singleValue === "string" && Object.keys(credentials).length === 1
      ? { value: singleValue }
      : { fields: credentials };
  const stored = await api.storeCredential({
    service: store.service,
    ...(store.label !== undefined ? { label: store.label } : {}),
    ...storeInput,
    ...(store.env_var_suggestion !== undefined
      ? { env_var_suggestion: store.env_var_suggestion }
      : {}),
    ...(store.type !== undefined ? { type: store.type } : { type: "api_key" }),
    ...(store.auth_shape !== undefined ? { auth_shape: store.auth_shape } : {}),
    ...(observedHosts.length > 0 ? { observed_hosts: observedHosts } : {}),
  });
  return {
    reference: stored.reference,
    service: stored.service,
    label: stored.label,
    field_names: stored.field_names,
    allowed_hosts: stored.allowed_hosts,
    updated: stored.updated,
  };
}

/**
 * Build the MCP-visible result after a successful vault write.
 *
 * `ExtractResult.credentials` contains the raw values read from the browser. A
 * stored extraction must never spread that object back into the MCP response:
 * the host/model receives only non-secret extraction and vault metadata.
 */
export function storedExtractResult(extracted: ExtractResult, stored: StoredCredentialMetadata) {
  return {
    session_id: extracted.session_id,
    url: extracted.url,
    candidate_count: extracted.candidate_count,
    ...(extracted.blocked_reason !== undefined ? { blocked_reason: extracted.blocked_reason } : {}),
    stored_credential: stored,
  };
}

// Change 2 — the pluggable terminal. Two outcome kinds: `credentials` (the
// signup case — extract + vault-store, byte-identical to operate_act's extract kind's
// store path) and `result` (any operate task — a summary + optional structured
// data: design-review findings, "task done" with confirmed in data, etc.).
// operate_finish is the single terminal. `outcome.kind` picks the shape.
const finishDataSchema = z.record(
  z.union([z.string().max(4000), z.number(), z.boolean()]).transform(String),
);

const finishOutcomeSchema = z.union([
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("credentials"),
    store: storeShape,
  }),
  z
    .object({
      kind: z.literal("result"),
      summary: z.string().max(4000).optional(),
      data: finishDataSchema.optional(),
      verify_recipe: z.string().min(1).max(80).optional(),
    })
    .refine((outcome) => outcome.summary !== undefined || outcome.data !== undefined, {
      message: "result outcome requires summary or data",
    }),
]);

type FinishOutcome = z.infer<typeof finishOutcomeSchema>;

async function handleFinishOutcome(
  sessionId: string,
  outcome: Exclude<FinishOutcome, { kind: "none" }>,
  api: ApiClient,
) {
  const { finish, prepared } = await finishProvisionSessionWithPreparation(sessionId, async () => {
    if (outcome.kind === "credentials") {
      const extracted = await extractCredentials(sessionId);
      const blocked = extracted.blocked_reason;
      const stored =
        Object.keys(extracted.credentials).length > 0
          ? await persistExtracted(sessionId, extracted.credentials, outcome.store, api)
          : null;
      const autoPromote =
        stored !== null && blocked === undefined
          ? await autoPromoteProvision(sessionId)
          : undefined;
      emitProvisionMeasurement(
        sessionId,
        stored !== null && blocked === undefined ? "success" : "fail",
      );
      return {
        kind: "credentials" as const,
        candidate_count: extracted.candidate_count,
        ...(blocked !== undefined ? { blocked_reason: blocked } : {}),
        stored_credential: stored,
        ...(autoPromote !== undefined ? { auto_promote: autoPromote } : {}),
      };
    }
    const verified =
      outcome.verify_recipe === undefined
        ? undefined
        : ((await verifyActiveRecipePostcondition(sessionId, outcome.verify_recipe)) ??
          (await verifySavedRecipePostcondition(
            sessionId,
            await readRecipe(outcome.verify_recipe),
          )));
    emitProvisionMeasurement(
      sessionId,
      verified === undefined || verified.confirmed ? "success" : "fail",
    );
    return {
      kind: "result" as const,
      summary: (outcome.summary ?? "").slice(0, 4000),
      ...(verified !== undefined ? { verified } : {}),
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    };
  });
  return { ...prepared, url: finish.url };
}

// Not part of the default MCP tool surface (dropped from OPERATE_TOOLS). Kept
// as an internal object — operate_finish{outcome} is the strict superset (also
// covers outcome.kind='none'). handleFinishOutcome is the shared implementation.
const finishTaskSchema = z.object({
  session_id: z.string().min(1),
  kind: z.enum(["credentials", "result"]),
  store: storeShape.optional(),
  summary: z.string().max(4000).optional(),
  data: finishDataSchema.optional(),
  verify_recipe: z.string().min(1).max(80).optional(),
});

export const provisionFinishTaskTool: Tool<z.infer<typeof finishTaskSchema>> = {
  name: "operate_finish_task",
  description:
    "Finish an operate task with its OUTCOME, then close the session. kind=" +
    "'credentials' extracts + vault-stores the key (pass `store`; same as " +
    "operate_extract's store), for signups/key-provisioning. kind='result' " +
    "reports a `summary` (+ optional `data` map) for any other task — a design " +
    "review's findings, extracted data, or 'task done' (put confirmed:true in " +
    "data). Use operate_finish instead to abort without an outcome. For a soft " +
    "no-match with kind='result' (for example, no exact or authentic item in " +
    "stock), first relay the closest candidates and why they were rejected, then " +
    "let the user choose a substitute, broader search, or another site before " +
    "finishing. Hard blockers such as anti-bot, CAPTCHA, 3-D Secure, or unsupported " +
    "payment should still be surfaced to the user immediately rather than worked around.",
  inputSchema: finishTaskSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "kind"],
    properties: {
      session_id: { type: "string" },
      kind: { type: "string", enum: ["credentials", "result"] },
      store: { type: "object", required: ["service"], properties: storeJsonProps },
      summary: { type: "string" },
      data: { type: "object" },
      verify_recipe: { type: "string" },
    },
  },
  async handler(args, api) {
    if (args.kind === "credentials") {
      if (args.store === undefined) {
        throw new Error("operate_finish_task kind=credentials requires `store`");
      }
      if (api === null) {
        throw new Error("operate_finish_task credentials requires an active Trusty Squire session");
      }
      return await handleFinishOutcome(
        args.session_id,
        { kind: "credentials", store: args.store },
        api,
      );
    }
    return await handleFinishOutcome(
      args.session_id,
      {
        kind: "result",
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.data !== undefined ? { data: args.data } : {}),
        ...(args.verify_recipe !== undefined ? { verify_recipe: args.verify_recipe } : {}),
      },
      api as ApiClient,
    );
  },
};

const finishSchema = z.object({
  session_id: z.string().min(1),
  outcome: finishOutcomeSchema.optional(),
});

export const provisionFinishTool: Tool<z.infer<typeof finishSchema>> = {
  name: "operate_finish",
  description:
    "Finish an operate task and close its session. outcome.kind='none' closes " +
    "without a reported outcome (and remains the default for compatibility); " +
    "'credentials' extracts and vault-stores a credential using required `store`; " +
    "'result' reports required `summary` or `data` and can verify_recipe before closing. " +
    "All credential values remain server-side; after Chrome closes, an eligible clean profile " +
    "may return to the closed warm slot for the next task.",
  inputSchema: finishSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      outcome: {
        oneOf: [
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { const: "none" } },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind", "store"],
            properties: {
              kind: { const: "credentials" },
              store: { type: "object", required: ["service"], properties: storeJsonProps },
            },
            additionalProperties: false,
          },
          {
            type: "object",
            required: ["kind"],
            anyOf: [{ required: ["summary"] }, { required: ["data"] }],
            properties: {
              kind: { const: "result" },
              summary: { type: "string" },
              data: { type: "object" },
              verify_recipe: { type: "string" },
            },
            additionalProperties: false,
          },
        ],
      },
    },
  },
  async handler(args, api) {
    const outcome = args.outcome ?? { kind: "none" as const };
    if (outcome.kind === "none") {
      return await finishProvisionSession(args.session_id);
    }
    if (outcome.kind === "credentials" && api === null) {
      throw new Error("operate_finish credentials requires an active Trusty Squire session");
    }
    return await handleFinishOutcome(args.session_id, outcome, api as ApiClient);
  },
};

// ── operator-recipe tools (Phase A — docs/ARCHITECTURE.md) ──

const rememberSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1).max(80),
  goal: z.string().min(1).max(300),
  verb: OperatorVerbSchema,
  inputs: z
    .object({
      address: z.record(z.string().max(2000)).optional(),
      contact: z.record(z.string().max(2000)).optional(),
      product_query: z.string().max(2000).optional(),
      credential: z.union([z.string().max(2000), z.record(z.string().max(2000))]).optional(),
      card: z.union([z.string().max(2000), z.record(z.string().max(2000))]).optional(),
      quantity: z.union([z.string().max(100), z.number()]).optional(),
    })
    .strict(),
  postcondition: PostconditionSchema,
});

export const provisionRememberTool: Tool<z.infer<typeof rememberSchema>> = {
  name: "operate_remember",
  description:
    "Save the CURRENT successful operate session as a replayable local recipe. " +
    "Pass the host-classified closed-enum `verb` and the complete authoritative `inputs` " +
    "ledger (address, contact, product_query, credential, card, quantity), plus a name, goal, and " +
    "`postcondition`. The postcondition is checked BEFORE anything is written — the " +
    "machine-checkable success signal: kind 'execute_capability' observes the " +
    "end-state now; `success_signal` is {field_text,min_value_len} (a field whose " +
    "value is at least N chars — checked by LENGTH, never the value), {text_present}, " +
    "or {url_contains}. The recipe stores the session's TEXT-targeted action trace " +
    "as a rail; sealed secrets become slot references, NEVER values. Call AFTER the " +
    "task succeeded; replay later by (verb, service URL), or by legacy name.",
  inputSchema: rememberSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "name", "goal", "verb", "inputs", "postcondition"],
    properties: {
      session_id: { type: "string" },
      name: { type: "string" },
      goal: { type: "string" },
      verb: { type: "string", enum: OperatorVerbSchema.options },
      inputs: { type: "object" },
      postcondition: {
        type: "object",
        required: ["kind", "describe", "success_signal"],
        properties: {
          kind: { type: "string", enum: ["execute_capability", "observe_artifact"] },
          describe: { type: "string" },
          success_signal: { type: "object" },
          probe_url: { type: "string" },
        },
      },
    },
  },
  async handler(args) {
    const result = await rememberRecipe(args.session_id, {
      name: args.name,
      goal: args.goal,
      postcondition: args.postcondition,
      verb: args.verb,
      inputs: args.inputs,
    });
    // replay-serve-live-domainlock — best-effort; never blocks or fails the local save.
    const registryPublish = await publishRecipeToRegistry(result.file);
    // replay-per-leg-signature — the checkout-leg recipe (when this session's
    // trace had one) publishes through the exact same path, under its own
    // shape-keyed domain slot. Also best-effort.
    const checkoutLegRegistryPublish =
      result.checkout_leg_file !== undefined
        ? await publishRecipeToRegistry(result.checkout_leg_file)
        : undefined;
    return {
      ...result,
      registry_publish: registryPublish,
      ...(checkoutLegRegistryPublish !== undefined
        ? { checkout_leg_registry_publish: checkoutLegRegistryPublish }
        : {}),
    };
  },
};

// replay-per-leg-signature — resolve (local, then registry, by the live
// checkout page's own field-name-set signature) and replay just the
// checkout leg on an already-open session. Degrades to a `cache_miss`-
// shaped result (never throws) whenever there's nothing to key by yet or
// nothing matches — the host keeps driving the leg cold either way.
// replayOperatorRecipe's own "replay already started" guard covers the one
// real misuse case (calling this while a whole-task replay is still
// active on the same session) with a clear error.
async function useCheckoutLegRecipe(
  sessionId: string,
  verb: OperatorVerb,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const signature = await checkoutShapeSignatureForSession(sessionId);
  if (signature === null) {
    return {
      ...(await observe(sessionId)),
      replay: {
        status: "cache_miss" as const,
        reason: "current page has no checkout field-name-set yet; continue cold",
      },
    };
  }
  const recipe = await resolveCheckoutLegRecipe(verb, signature);
  if (recipe === null) {
    return {
      ...(await observe(sessionId)),
      replay: {
        status: "cache_miss" as const,
        reason: "no recipe for this checkout shape; continue cold",
      },
    };
  }
  const replay = await replayOperatorRecipe(sessionId, recipe, params, 0);
  const { observation, ...replayState } = replay;
  return { ...observation, replay: replayState };
}

const useSchema = z
  .object({
    // Legacy selector; new calls use verb + service_url.
    name: z.string().min(1).max(80).optional(),
    verb: OperatorVerbSchema.optional(),
    service_url: z.string().url().optional(),
    params: z.record(z.string().max(2000)).optional(),
    require_live_identity: z.boolean().optional(),
    // After the host repairs one missed step, resume the same live session at
    // replay.next_index instead of starting over.
    session_id: z.string().min(1).optional(),
    resume_from: z.number().int().min(0).max(200).optional(),
    // replay-per-leg-signature — resolve+replay the CHECKOUT LEG only,
    // independently of any whole-task (verb, domain) recipe, against an
    // already-open session's CURRENT page. Requires verb + session_id, no
    // service_url (the session already has its own live page) and no
    // resume_from (this always starts a fresh leg-scoped replay attempt).
    leg: z.enum(["checkout"]).optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      (value.verb !== undefined && value.service_url !== undefined) ||
      (value.verb !== undefined && value.leg === "checkout" && value.session_id !== undefined),
    {
      message:
        "provide legacy name, or both verb and service_url, or verb + session_id with leg:'checkout'",
    },
  )
  .refine((value) => value.leg === undefined || value.resume_from === undefined, {
    message: "leg:'checkout' always starts a fresh leg replay; it does not take resume_from",
  })
  .refine(
    (value) =>
      value.leg === undefined ||
      (value.verb !== undefined &&
        value.session_id !== undefined &&
        value.service_url === undefined),
    {
      message:
        "leg:'checkout' requires verb + session_id and takes no service_url (the session already has its own live page)",
    },
  )
  .refine(
    (value) =>
      value.leg !== undefined ||
      (value.session_id === undefined) === (value.resume_from === undefined),
    { message: "session_id and resume_from must be provided together" },
  );

export const provisionUseTool: Tool<z.infer<typeof useSchema>> = {
  name: "operate_use",
  description:
    "Replay a local prepared-statement recipe selected by the host-classified closed-enum " +
    "verb plus service_url (eTLD+1 keyed; path/query ignored). A legacy name opens the " +
    "saved workflow as a planning hint without deterministic replay. Binds " +
    "hole values and executes each step through ordered target fallback. A single miss " +
    "returns replay.status='fallback_required' with that step and next_index; repair only " +
    "that step, then call operate_use again with the same params plus session_id + " +
    "resume_from=next_index. A recipe whose entry or declared hosts would leave its own " +
    "site (a tampered or malicious shared recipe) is refused outright: " +
    "replay.status='domain_lock_violation', and driving continues cold. " +
    "Money-path completion deterministically verifies every injected address/contact/qty field. " +
    "Pass verb + session_id + leg:'checkout' (no service_url) to resolve+replay just the " +
    "CHECKOUT leg against an already-open session's current page — keyed by the checkout page's " +
    "own field-name-set signature, so a checkout plan recorded on one store can replay on a " +
    "different, unrelated store of the same checkout platform (cross-domain reuse). " +
    "replay.status='cache_miss' means no recipe matches this page's shape; drive the checkout " +
    "leg cold. A money-path guard failure on a recipe with a real catalog/storefront prefix " +
    "returns replay.status='leg_fallback_required' (not human_required) — the session's " +
    "fail-closed payment gate stays shut for its remainder (operate_pay, operate_remember, and " +
    "further operate_use calls on that session are refused); non-payment checkout steps can " +
    "still be driven cold from from_step_index, but completing payment requires a fresh " +
    "operate_start.",
  inputSchema: useSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      verb: { type: "string", enum: OperatorVerbSchema.options },
      service_url: { type: "string" },
      params: { type: "object" },
      require_live_identity: { type: "boolean" },
      session_id: { type: "string" },
      resume_from: { type: "integer" },
      leg: { type: "string", enum: ["checkout"] },
    },
  },
  async handler(args, api) {
    if (args.leg === "checkout") {
      return await useCheckoutLegRecipe(args.session_id!, args.verb!, args.params ?? {});
    }
    let recipe: Awaited<ReturnType<typeof readRecipe>>;
    try {
      recipe =
        args.name !== undefined
          ? await readRecipe(args.name)
          : await resolveRecipeForTask(args.verb!, args.service_url!);
    } catch (error) {
      // A keyed cache miss is the expected cold path, not a task failure.
      if (
        args.name !== undefined ||
        args.service_url === undefined ||
        args.session_id !== undefined
      ) {
        throw error;
      }
      const cold = await startProvisionSession({
        serviceUrl: args.service_url,
        consentInboxRead: await readInboxConsent(),
        ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
        ...(api !== null ? { api } : {}),
      });
      if (cold.needs_user !== undefined) return cold;
      return {
        ...cold,
        replay: {
          status: "cache_miss" as const,
          reason: "no local recipe for this (verb, eTLD+1); continue cold",
        },
      };
    }
    if (recipe.domain !== undefined && isCheckoutShapeKey(recipe.domain)) {
      throw new Error(
        `operator-recipe "${recipe.name}" is a checkout-leg recipe and can only be replayed via operate_recipe_run{leg:"checkout"}`,
      );
    }
    const entry = recipeEntryUrl(recipe, args.service_url);
    if (entry === null) {
      throw new Error(
        recipe.entry_mode === "runtime_service_url"
          ? `operator-recipe "${recipe.name}" requires verb + service_url to resolve its runtime entry`
          : `operator-recipe "${recipe.name}" has no stable entry (goto) step to start from`,
      );
    }
    const { url, missing } = fillTemplate(entry, args.params ?? {});
    if (missing.length > 0) {
      throw new Error(
        `operator-recipe "${recipe.name}" needs params: ${missing.join(", ")} — ` +
          `pass them as operate_recipe_run{ params: { ${missing.map((m) => `${m}: "..."`).join(", ")} } }`,
      );
    }
    const domainLockViolation = recipeDomainLockViolationForReplay(recipe, url);
    if (domainLockViolation !== null) {
      // Hard stop — never start or continue a session with this recipe.
      // Same "can't cold-start over an existing call shape" guard the
      // cache-miss branch above uses; a resume/named/leg-less call just
      // throws instead of silently retargeting.
      if (
        args.name !== undefined ||
        args.service_url === undefined ||
        args.session_id !== undefined
      ) {
        throw new Error(`operator-recipe "${recipe.name}" refused: ${domainLockViolation}`);
      }
      const cold = await startProvisionSession({
        serviceUrl: args.service_url,
        consentInboxRead: await readInboxConsent(),
        ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
        ...(api !== null ? { api } : {}),
      });
      if (cold.needs_user !== undefined) return cold;
      return {
        ...cold,
        replay: {
          status: "domain_lock_violation" as const,
          reason: domainLockViolation,
        },
      };
    }
    let sessionId = args.session_id;
    const legacyHintOnly = recipe.verb === undefined || recipe.domain === undefined;
    if (legacyHintOnly && sessionId !== undefined) {
      throw new Error("legacy named recipes are hint-only and do not support replay continuation");
    }
    if (sessionId === undefined) {
      const consentInboxRead = await readInboxConsent();
      const started = await startProvisionSession({
        serviceUrl: url,
        consentInboxRead,
        ...(recipe.allowed_hosts.length > 0 ? { extraAllowedHosts: recipe.allowed_hosts } : {}),
        hint: renderOperatorRecipeHint(recipe),
        ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
        ...(api !== null ? { api } : {}),
      });
      if (started.needs_user !== undefined) return started;
      if (legacyHintOnly) {
        return {
          ...started,
          replay: {
            status: "legacy_hint_only" as const,
            reason: "legacy named recipe has no closed-enum verb/domain classification",
          },
        };
      }
      sessionId = started.session_id;
    }
    const replay = await replayOperatorRecipe(
      sessionId,
      recipe,
      args.params ?? {},
      args.resume_from ?? 0,
    );
    const { observation, ...replayState } = replay;
    return { ...observation, replay: replayState };
  },
};

export const operateRecipeSaveTool: Tool<z.infer<typeof rememberSchema>> = {
  ...provisionRememberTool,
  name: "operate_recipe_save",
  description: provisionRememberTool.description.replaceAll(
    "operate_remember",
    "operate_recipe_save",
  ),
};

export const operateRecipeRunTool: Tool<z.infer<typeof useSchema>> = {
  ...provisionUseTool,
  name: "operate_recipe_run",
  description: provisionUseTool.description
    .replaceAll("operate_use", "operate_recipe_run")
    .replaceAll("operate_remember", "operate_recipe_save"),
};

// PR3c — username/password signup credential lifecycle (no Trusty Squire alias).
const prepareLoginSchema = z.object({
  session_id: z.string().min(1),
  login_slot: z.string().min(1).max(60).optional(),
  password_slot: z.string().min(1).max(60).optional(),
  password_length: z.number().int().min(16).max(64).optional(),
});

async function handlePrepareLogin(args: z.infer<typeof prepareLoginSchema>) {
  const email = getSessionUserEmail(args.session_id);
  if (email === null) {
    return {
      session_id: args.session_id,
      needs_user: {
        wall: "user_email",
        message:
          "No user email is on file for this session, so the operator cannot " +
          "fill a user-owned signup. Ask the user to run `npx @trusty-squire/mcp " +
          "connect` (Google login) so their identity is captured, then retry.",
        resume: "connect",
      },
    };
  }
  const login = stashSecretSlot(args.session_id, args.login_slot ?? "login", email);
  const password = stashSecretSlot(
    args.session_id,
    args.password_slot ?? "password",
    generatePassword(args.password_length ?? 24),
  );
  return {
    session_id: args.session_id,
    slots: { login, password },
    email_preview: login.preview,
  };
}

export const provisionPrepareLoginTool: Tool<z.infer<typeof prepareLoginSchema>> = {
  name: "operate_prepare_login",
  description:
    "Prepare username/password signup fields from the user's OWN email (captured " +
    "at login) and a freshly generated strong password. Both are sealed into " +
    "session slots — you get only masked handles, never the raw values. Fill the " +
    "signup form with operate_act{kind:'type_secret'} using the returned login/" +
    "password slots, then after the account is created call operate_store_login to " +
    "vault them. This never uses a Trusty Squire alias — the account is the user's. " +
    "If no user email was captured, a needs_user hand-back asks the user to run " +
    "`connect` so the operator has their Google identity.",
  inputSchema: prepareLoginSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      login_slot: { type: "string" },
      password_slot: { type: "string" },
      password_length: { type: "number" },
    },
  },
  handler: handlePrepareLogin,
};

// The signin_url's host is, by definition, where this login gets filled back —
// but the agent's login_hosts don't always include it (it stored the apex while
// the form lives on app.<domain>, so browser-fill 403'd login_host_not_allowed).
// Fold the signin_url host into login_hosts so a credential can always be filled
// at its own signin_url. Exported for tests. MEASURED 2026-07-02 (Plunk).
export function withSigninHost(loginHosts: readonly string[], signinUrl?: string): string[] {
  if (signinUrl === undefined) return [...loginHosts];
  let host: string;
  try {
    host = new URL(signinUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return [...loginHosts];
  }
  if (host.length === 0 || loginHosts.includes(host)) return [...loginHosts];
  return [...loginHosts, host];
}

const storeLoginSchema = z.object({
  session_id: z.string().min(1),
  service: z.string().min(1).max(120),
  login_slot: z.string().min(1).max(60).optional(),
  password_slot: z.string().min(1).max(60).optional(),
  label: z.string().min(1).max(120).optional(),
  signin_url: z.string().url().optional(),
  login_hosts: z.array(z.string().min(1).max(253)).min(1).max(20),
});

async function handleStoreLogin(args: z.infer<typeof storeLoginSchema>, api: ApiClient | null) {
  if (api === null) {
    throw new Error("operate_store_login requires an active Trusty Squire session");
  }
  const login = readSecretSlotValue(args.session_id, args.login_slot ?? "login");
  const password = readSecretSlotValue(args.session_id, args.password_slot ?? "password");
  const observedHosts = observedHostsForSession(args.session_id);
  const stored = await api.storeCredential({
    service: args.service,
    ...(args.label !== undefined ? { label: args.label } : {}),
    fields: { login, password },
    type: "username_password",
    auth_strategy: "username_password",
    login_hosts: withSigninHost(args.login_hosts, args.signin_url),
    ...(args.signin_url !== undefined ? { signin_url: args.signin_url } : {}),
    ...(observedHosts.length > 0 ? { observed_hosts: observedHosts } : {}),
  });
  return {
    session_id: args.session_id,
    reference: stored.reference,
    service: stored.service,
    type: "username_password",
    field_names: stored.field_names,
    login_hosts: stored.login_hosts,
    signin_url: stored.signin_url,
    updated: stored.updated,
  };
}

export const provisionStoreLoginTool: Tool<z.infer<typeof storeLoginSchema>> = {
  name: "operate_store_login",
  description:
    "After the service account is created, vault the sealed signup login (the " +
    "user's email + the generated password from operate_prepare_login) as a " +
    "username_password credential so the user can sign back in. Reads the sealed " +
    "slots server-side; raw values are never returned to you. Pass the exact " +
    "login hosts where this credential may be filled; use *.example.com only " +
    "when subdomains are intentionally allowed. The signin_url host (if given) is " +
    "always included, so the credential can be filled at its own sign-in page.",
  inputSchema: storeLoginSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "service", "login_hosts"],
    properties: {
      session_id: { type: "string" },
      service: { type: "string" },
      login_slot: { type: "string" },
      password_slot: { type: "string" },
      label: { type: "string" },
      signin_url: { type: "string" },
      login_hosts: { type: "array", items: { type: "string" } },
    },
  },
  handler: handleStoreLogin,
};

const sealVaultCredentialBaseSchema = z.object({
  session_id: z.string().min(1),
  reference: z.string().min(1).max(400).optional(),
  service: z.string().min(1).max(120).optional(),
  fields: z.array(z.string().min(1).max(120)).min(1).max(20).default(["login", "password"]),
  slot_prefix: z.string().min(1).max(60).default("vault"),
});

const sealVaultCredentialSchema = sealVaultCredentialBaseSchema.refine(
  (b) => b.reference !== undefined || b.service !== undefined,
  {
    message: "one of reference or service is required",
  },
);

async function handleSealVaultCredential(
  args: z.infer<typeof sealVaultCredentialSchema>,
  api: ApiClient | null,
) {
  if (api === null) {
    throw new Error("operate_seal_vault_credential requires an active Trusty Squire session");
  }
  const current = currentProvisionUrl(args.session_id);
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const response = await api.browserFillCredential({
    ...(args.reference !== undefined ? { reference: args.reference } : {}),
    ...(args.service !== undefined ? { service: args.service } : {}),
    current_host: current,
    fields: args.fields,
    encrypted_response_public_key: publicKey,
  });
  const slots: Record<string, ReturnType<typeof stashSecretSlot>> = {};
  for (const [field, encrypted] of Object.entries(response.encrypted_fields)) {
    const value = privateDecrypt(
      {
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      Buffer.from(encrypted, "base64"),
    ).toString("utf8");
    slots[field] = stashSecretSlot(args.session_id, `${args.slot_prefix}_${field}`, value);
  }
  return {
    session_id: args.session_id,
    reference: response.reference,
    slots,
  };
}

export const provisionSealVaultCredentialTool: Tool<z.infer<typeof sealVaultCredentialSchema>> = {
  name: "operate_seal_vault_credential",
  description:
    "For a sign-in page, retrieve a username/password credential only if the " +
    "current browser host is allowed for login, then seal requested fields into " +
    "session slots. Raw values are never returned; use operate_act type_secret " +
    "with the returned slot names to fill the page.",
  inputSchema: sealVaultCredentialSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    anyOf: [{ required: ["reference"] }, { required: ["service"] }],
    properties: {
      session_id: { type: "string" },
      reference: { type: "string" },
      service: { type: "string" },
      fields: { type: "array", items: { type: "string" } },
      slot_prefix: { type: "string" },
    },
  },
  handler: handleSealVaultCredential,
};

const loginPrepareSignupSchema = prepareLoginSchema.extend({
  action: z.literal("prepare_signup"),
});
const loginStoreSignupSchema = storeLoginSchema.extend({
  action: z.literal("store_signup"),
});
const loginLoadSavedSchema = sealVaultCredentialBaseSchema
  .extend({ action: z.literal("load_saved") })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });
const loginSchema = z.union([
  loginPrepareSignupSchema,
  loginStoreSignupSchema,
  loginLoadSavedSchema,
]);

export const operateLoginTool: Tool<z.infer<typeof loginSchema>> = {
  name: "operate_login",
  description:
    "Drive the sealed username/password login lifecycle without exposing raw values. " +
    "action='prepare_signup' seals the user's captured email and a generated password; " +
    "'store_signup' vaults those prepared slots with the same login-host safeguards; " +
    "'load_saved' fetches an allowed saved login through encrypted browser-fill and seals " +
    "its fields into session slots. Use operate_act kind='type_secret' to fill returned slots.",
  inputSchema: loginSchema,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        required: ["action", "session_id"],
        properties: {
          action: { const: "prepare_signup" },
          session_id: { type: "string" },
          login_slot: { type: "string" },
          password_slot: { type: "string" },
          password_length: { type: "number" },
        },
      },
      {
        required: ["action", "session_id", "service", "login_hosts"],
        properties: {
          action: { const: "store_signup" },
          session_id: { type: "string" },
          service: { type: "string" },
          login_slot: { type: "string" },
          password_slot: { type: "string" },
          label: { type: "string" },
          signin_url: { type: "string" },
          login_hosts: { type: "array", items: { type: "string" } },
        },
      },
      {
        required: ["action", "session_id"],
        anyOf: [{ required: ["reference"] }, { required: ["service"] }],
        properties: {
          action: { const: "load_saved" },
          session_id: { type: "string" },
          reference: { type: "string" },
          service: { type: "string" },
          fields: { type: "array", items: { type: "string" } },
          slot_prefix: { type: "string" },
        },
      },
    ],
  },
  async handler(args, api) {
    switch (args.action) {
      case "prepare_signup":
        return await handlePrepareLogin(args);
      case "store_signup":
        return await handleStoreLogin(args, api);
      case "load_saved":
        return await handleSealVaultCredential(args, api);
    }
  },
};

// Bare-essentials cut (captain's decision 2026-08-15): the operator surface is
// these 6 plus operate_pay and operate_payment_status, which are wired separately
// in tools/index.ts. diagnostics remain behind the opt-in profile.
// Every dropped alias's behavior remains reachable: cart_add/select_many/
// extract/solve_captcha/await_verification/login_prepare_signup/login_store_signup/
// login_load_saved as operate_act kinds; operate_finish_task as operate_finish{outcome}.
// The alias Tool objects above stay defined (unregistered) as the shared implementation
// operate_act's kinds and operate_recipe_save/run delegate to, and as direct handles
// for tests that pin down that folded behavior.
export const OPERATE_TOOLS: Tool[] = [
  provisionStartTool,
  provisionObserveTool,
  provisionActTool,
  operateRecipeSaveTool,
  operateRecipeRunTool,
  provisionFinishTool,
] as Tool[];
