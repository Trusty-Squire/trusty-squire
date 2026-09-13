import { ScreenshotClickError } from "../bot/screenshot-click.js";
import { captureSourceSchema, describeCaptureSource } from "../bot/credential-capture.js";
import {
  currentOperatorOperationId,
  markOperatorMutationDispatchAttempted,
  operatorMutationDispatchPhase,
  persistOperatorCaptureEvidence,
  throwIfOperatorRequestCancelled,
} from "../bot/request-cancellation.js";
import { createHash, randomUUID } from "node:crypto";
// Phase 1 — the interactive provisioning tool surface a frontier HOST agent
// drives. The host is the planner; these tools are the browser + the moat.
// Backed by ../bot/provision-session.ts (the session registry over the existing
// BrowserController substrate).
// Browser egress compatibility is documented in docs/operator-tool-surface.md.

import { z } from "zod";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import type { Tool } from "./index.js";
import type { ApiClient } from "../api-client.js";
import {
  startProvisionSession,
  observe,
  captureScreenshot,
  readOperatorEvidence,
  observeSubtree,
  observeQuery,
  act,
  formSelectMany,
  TargetStaleError,
  extractCredentials,
  captureCredentialSource,
  probeCaptureSource,
  type CaptureSourceProbe,
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
  PostconditionSchema,
  type OperatorVerb,
  type OperatorRecipe,
} from "../bot/operator-recipe.js";
import { isMaskedDisplay } from "../bot/credential-shape.js";
import { renderSkillHint, serviceSlugFromUrl } from "../bot/skill-hint.js";
import { clientFromEnv, generateProvisionId } from "../skill-registry-client.js";
import { openSessionStorage } from "../session.js";
import { servingAccountId } from "../session-guard.js";
import { sessionForCall } from "../bot/session/lifecycle.js";
import { clickDispatchStatusForError } from "../bot/browser.js";

// Read the install-time inbox-read preference. Inbox reads default on; an
// explicit false in the saved advanced configuration remains an opt-out.
async function readInboxConsent(): Promise<boolean> {
  try {
    const accountId = resolveAccountId();
    if (accountId === undefined) return true;
    const data = await (await openSessionStorage()).read(accountId);
    return data?.consent_operator_inbox_otp !== false;
  } catch {
    return true;
  }
}

// The account THIS server adopted, as published by its SessionGuard. Never
// re-resolve it here from TRUSTY_SQUIRE_ACCOUNT_ID or the store's
// current-account pointer: a server launched from a pre-pin config binds by
// fallback, and re-resolving after another account connects would hand this
// tool the wrong account — applying that account's consent setting and
// attributing registry reads/publishes to it. That is exactly the "acting as
// an account it never bound to" defect this work exists to remove.
function resolveAccountId(): string | undefined {
  return servingAccountId();
}

// Best-effort: ask the registry for a known route for this service so the agent
// drives on rails instead of ad-hoc. Returns undefined on any miss (no skill,
// no registry configured, network error) — the agent just drives without it.
async function resolveRouteHint(serviceUrl: string): Promise<string | undefined> {
  try {
    const accountId = resolveAccountId();
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
// outcome is recorded in the operate_finish result trail, nothing is thrown.
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
    const accountId = resolveAccountId();
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
    const accountId = resolveAccountId();
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
    const accountId = resolveAccountId();
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
    const accountId = resolveAccountId();
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

const proxySchema = z
  .string()
  .min(1)
  .max(2048)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proxy must be a valid HTTP, HTTPS, or SOCKS5 URL",
      });
      return;
    }
    if (parsed.hostname.length === 0 || !["http:", "https:", "socks5:"].includes(parsed.protocol)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proxy must be a valid HTTP, HTTPS, or SOCKS5 URL",
      });
      return;
    }
    if (
      parsed.protocol === "socks5:" &&
      (parsed.username.length > 0 || parsed.password.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Authenticated SOCKS5 is unsupported by the browser engine; use HTTP/HTTPS with credentials or unauthenticated SOCKS5",
      });
      return;
    }
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.password.length > 0 &&
      parsed.username.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Password-only HTTP/HTTPS proxy credentials are unsupported; include a non-empty username or use an unauthenticated proxy",
      });
      return;
    }
    try {
      decodeURIComponent(parsed.username);
      decodeURIComponent(parsed.password);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "proxy credentials contain invalid percent encoding",
      });
    }
  });

const startSchema = z.object({
  service_url: z.string().url(),
  format: z.enum(["compact", "full"]).optional(),
  // Sensitive: may include proxy credentials. It is launch-only and is never
  // retained in the session state, action trail, status, or recipe.
  proxy: proxySchema.optional(),
  // Deprecated compatibility parameters; browser egress is unrestricted.
  allowed_hosts: z.array(z.string().min(1).max(120)).max(20).optional(),
  extra_allowed_hosts: z.array(z.string().min(1).max(120)).max(10).optional(),
  // Operate tasks that act AS the user (drive a gated app on an existing
  // account) set this so start fails closed to a connect hand-back if no live
  // Google session exists — rather than driving into a mid-task login wall.
});

const DOM_OBSERVATION_CONTRACT =
  'With `format:"full"`, the response format is `browser-use-dom`: `session_id` continues the session, `url` is the live page URL, ' +
  "and `stage` identifies the page stage. `dom` is a tab-indented tree with interleaved visible text: " +
  "`[@e:...]<tag attributes />` identifies a control; attributes may include field values and state. " +
  "`|SHADOW(open)|` / `|SHADOW(closed)|` mark shadow hosts, with Open/Closed Shadow and Shadow End boundaries. " +
  "`not-targetable=true` marks display-only refs that cannot be acted on. `*` before a ref marks a new " +
  "element or compound control. `more_above` / `more_below` indicate content beyond the viewport; use operate_scroll. " +
  "`delta:true` means the same document: when `dom` is present it replaces the entire prior tree; " +
  "when omitted retain the prior tree. `removed` lists refs that left the rendered view. " +
  "Without delta:true, reset the prior view. Refs stay usable on the same document; on stale_ref, " +
  "call operate_observe and choose a current ref. ";

const CONTROL_QUERY_CONTRACT =
  'The default `format:"compact"` response is `browser-use-control-query`. It contains every actionable control ' +
  "(button, link, textbox, select, checkbox, radio, tab, menuitem, and file), including off-viewport controls; " +
  "non-control markup and arbitrary page text are absent by construction, not redacted. Query or role filters this same map. " +
  "Its `safe_table` is a paged control map: each row is `[ref,role,facts?]`; role is " +
  "b=button, l=link, t=textbox, s=select, c=checkbox, r=radio, tb=tab, m=menuitem, or f=file; other roles are literal (e.g. slider or generic for a listener container). " +
  "facts is a `|`-joined `@label` alias followed by present s=state (c=checked, u=unchecked, d=disabled, r=required), " +
  "v=offscreen when outside the viewport, a=action, f=field, q=choice-position/total, and x=s same-origin or x=x cross-origin frame; absent x means main frame. " +
  "Query matches include m=n (exact name), m=r (exact role), m=t (local text), or m=c (explicit form/fieldset/dialog context), ranked in that order. " +
  "semantic.blocked=true and semantic.blockers report visible verification instructions or validation errors independently of stage; stage=browse does not mean unblocked. " +
  "Cursors page an immutable snapshot and require the same query and role; document changes invalidate them. A cursorless query captures fresh controls and semantics. " +
  "Use overflow.next_cursor to page safe_table. A cursor from hint_overflow returns `hint` and pages with hint_overflow.next_cursor. ";

const ACTION_FORMAT_NOTE =
  "The action response is the compact `browser-use-control-query` control map by default: after a compact map on the same document, `delta:true` carries changed/new controls in `safe_table` and departed refs in `removed`, never the verbatim DOM. " +
  'Pass `format:"full"` to receive the verbatim `browser-use-dom` tree instead. Nothing is redacted in either format. ';

const ACTION_FORMATS = ["compact", "full"] as const;
const actionFormatSchema = z.enum(ACTION_FORMATS);
const actionFormatJson = { type: "string", enum: [...ACTION_FORMATS] };

export const provisionStartTool: Tool<z.infer<typeof startSchema>> = {
  name: "operate_start",
  description:
    "Begin an interactive website task: opens a browser on the " +
    "user's machine at service_url and returns the initial page observation. " +
    CONTROL_QUERY_CONTRACT +
    'Use `format:"full"` only when the verbatim page DOM and text are needed. Nothing is redacted in either format. ' +
    DOM_OBSERVATION_CONTRACT +
    "YOU are the planner — read the observation, then drive the signup, setup, or " +
    "checkout with operate_click, operate_type, operate_select, operate_navigate, operate_scroll, and operate_login (operate_pay for a purchase), re-read with " +
    "operate_observe, and call operate_extract " +
    "when you reach the credentials. Always operate_finish when done. The " +
    "browser has unrestricted egress. If the " +
    "registry knows this service, the first observation includes a `hint` — the " +
    "route (login method, where the key lives, how many credentials). Read it and " +
    "drive toward it; fall back to your own judgment if the live page diverges.",
  inputSchema: startSchema,
  jsonInputSchema: {
    type: "object",
    required: ["service_url"],
    properties: {
      service_url: { type: "string" },
      format: { type: "string", enum: ["compact", "full"] },
      proxy: {
        type: "string",
        description:
          "Optional per-session HTTP/HTTPS proxy URL with or without credentials, or unauthenticated SOCKS5 URL. HTTP/HTTPS passwords require a non-empty username; authenticated SOCKS5 is unsupported by the browser engine. Sensitive and launch-only; never returned or saved.",
      },
      allowed_hosts: { type: "array", items: { type: "string" } },
      extra_allowed_hosts: { type: "array", items: { type: "string" } },
    },
  },
  async handler(args, api) {
    const hint = await resolveRouteHint(args.service_url);
    const consentInboxRead = await readInboxConsent();
    return await startProvisionSession({
      serviceUrl: args.service_url,
      format: args.format ?? "compact",
      consentInboxRead,
      ...(args.proxy !== undefined ? { proxyUrl: args.proxy } : {}),
      ...(hint !== undefined ? { hint } : {}),
      // Thread the api-client so the captcha gate can spend a vaulted 2Captcha key.
      ...(api !== null ? { api } : {}),
    });
  },
};

const observeSchema = z.object({
  session_id: z.string().min(1),
  query: z.string().max(160).optional(),
  cursor: z.string().max(1024).optional(),
  role: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe("Emitted control role, including literal roles such as slider or generic")
    .optional(),
  format: z.enum(["compact", "full"]).optional(),
  subtree_ref: z.string().min(1).max(512).optional(),
  raw_attributes: z.boolean().optional(),
});

export const provisionObserveTool: Tool<z.infer<typeof observeSchema>> = {
  name: "operate_observe",
  description:
    "Re-read the current page of an operate session. " +
    CONTROL_QUERY_CONTRACT +
    'Use `format:"full"` only when the verbatim page DOM and text are needed. Nothing is redacted in either format. ' +
    DOM_OBSERVATION_CONTRACT +
    "Supplying query, role, or cursor always selects the compact control-map path, regardless of format. " +
    "Explicit legacy sessions (TRUSTY_SQUIRE_OBSERVE_V2=off or shadow) return legacy observations.",
  inputSchema: observeSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      query: { type: "string" },
      cursor: { type: "string" },
      role: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        pattern: "^[a-z][a-z0-9-]*$",
      },
      format: { type: "string", enum: ["compact", "full"] },
      subtree_ref: { type: "string" },
      raw_attributes: { type: "boolean" },
    },
  },
  async handler(args) {
    if (args.subtree_ref !== undefined) {
      return await observeSubtree(args.session_id, args.subtree_ref, args.raw_attributes === true);
    }
    if (args.query !== undefined || args.cursor !== undefined || args.role !== undefined) {
      return await observeQuery(args.session_id, args.query ?? "", args.role, args.cursor);
    }
    return await observe(args.session_id, args.format ?? "compact");
  },
};

const screenshotSchema = z.object({
  session_id: z.string().min(1),
  // Index into the SAME frame ordering operate_observe's frame_origin
  // implies (page.frames() order) — capture one frame in isolation instead
  // of the whole page. Mutually exclusive with frame_url_contains; pass at
  // most one.
  frame_index: z.number().int().min(0).optional(),
  // A substring of a frame's URL (e.g. "cardinalcommerce.com") — capture
  // whichever frame matches instead of the whole page.
  frame_url_contains: z.string().min(1).max(300).optional(),
  // Default false (viewport only, matches what a human actually sees).
  // Ignored when a frame is targeted (a frame capture is always that
  // frame's own full box).
  full_page: z.boolean().optional(),
});

export const provisionScreenshotTool: Tool<z.infer<typeof screenshotSchema>> = {
  name: "operate_screenshot",
  description:
    "WARNING: EXPENSIVE — a screenshot is a full image and costs far more context than any " +
    "observation. Reach for it ONLY when the DOM tree or control search (" +
    "operate_observe with query/cursor) is NOT sufficient to determine the page state; " +
    "if the observation already tells you what the page is doing, do not take one. " +
    "Debugging tool: capture a screenshot of what the operate session's browser actually RENDERS — " +
    "the whole page (default: viewport; full_page:true for the whole scrollable page) or ONE specific " +
    "frame in isolation via frame_index or frame_url_contains, so a cross-origin challenge iframe (a " +
    "3-D Secure ACS frame, a captcha) can be captured on its own even when it won't show clearly inside " +
    "a full-page shot. Use this when the DOM tree, or text/el_table from an explicitly " +
    "selected V1 session, isn't enough to tell what state " +
    "a stuck page is actually in — a challenge that never advances, an unexpected layout, a captcha you " +
    "need to SEE. Read-only: never navigates, clicks, types, submits, or steals focus; it only reads " +
    "pixels. The image is the page's real pixels, whatever the page is showing. When click_binding is present, its screenshot_id and original image width/height authorize one operate_click screenshot point for 60 seconds. Navigation, viewport/scroll or frame geometry changes invalidate it. An absent binding means this image is read-only; capture again for a coordinate click.",
  inputSchema: screenshotSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      frame_index: { type: "number" },
      frame_url_contains: { type: "string" },
      full_page: { type: "boolean" },
    },
  },
  jsonOutputSchema: {
    type: "object",
    properties: {
      click_binding: {
        type: "object",
        required: ["screenshot_id", "width", "height", "coordinate_space"],
        properties: {
          screenshot_id: { type: "string", format: "uuid" },
          width: { type: "integer", minimum: 1 },
          height: { type: "integer", minimum: 1 },
          coordinate_space: { const: "image_pixels" },
        },
      },
    },
    additionalProperties: true,
  },
  async handler(args) {
    return await captureScreenshot(args.session_id, {
      ...(args.frame_index !== undefined ? { frameIndex: args.frame_index } : {}),
      ...(args.frame_url_contains !== undefined
        ? { frameUrlContains: args.frame_url_contains }
        : {}),
      ...(args.full_page !== undefined ? { fullPage: args.full_page } : {}),
    });
  },
};

const networkSchema = z.object({
  session_id: z.string().min(1),
  since: z.number().int().min(0).optional(),
  request_id: z.string().min(1).max(256).optional(),
});

export const provisionNetworkTool: Tool<z.infer<typeof networkSchema>> = {
  name: "operate_network",
  description:
    "Read raw browser evidence collected since session start: requests, responses, pending/completed/failed state, HTTP status, loading failures, CORS/blocked reasons, console messages, exceptions, and screenshot events. Pass the returned cursor as since for an incremental read, or request_id for one request. This surface does not diagnose payment stages. Released card PAN/CVV copies are masked; status bodies and all unrelated values remain visible.",
  inputSchema: networkSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      since: { type: "integer", minimum: 0 },
      request_id: { type: "string" },
    },
  },
  annotations: { readOnlyHint: true },
  async handler(args) {
    return readOperatorEvidence(args.session_id, args.since ?? 0, args.request_id);
  },
};

// Shared credential destination shape for extraction and completion.
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

const captureSchema = z
  .object({
    store: storeShape,
    source: captureSourceSchema,
    write_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9:_-]+$/)
      .optional(),
  })
  .strict();
const captureJson = {
  type: "object",
  additionalProperties: false,
  required: ["store", "source"],
  properties: {
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
    source: {
      type: "object",
      additionalProperties: false,
      oneOf: [
        { required: ["role"], not: { required: ["selector"] } },
        {
          required: ["selector"],
          not: { anyOf: [{ required: ["role"] }, { required: ["name"] }] },
        },
      ],
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 2000 },
        role: { type: "string", enum: ["textbox", "code"] },
        name: { type: "string", maxLength: 200 },
        container: {
          type: "object",
          additionalProperties: false,
          required: ["role"],
          properties: {
            role: { type: "string", enum: ["dialog", "region"] },
            name: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    write_id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9:_-]+$" },
  },
};

async function captureIntoVault(
  sessionId: string,
  capture: z.infer<typeof captureSchema>,
  api: ApiClient,
  afterAction?: { pre?: CaptureSourceProbe | undefined },
) {
  const writeId = capture.write_id!;
  const binding = createHash("sha256")
    .update(JSON.stringify([capture.store.service, capture.store.label ?? null]))
    .digest("hex");
  const base = {
    session_id: sessionId,
    operation_id: currentOperatorOperationId() ?? writeId,
    write_id: writeId,
    mutation:
      operatorMutationDispatchPhase() === "prepared"
        ? "not_dispatched"
        : operatorMutationDispatchPhase() === "dispatch_attempted"
          ? "dispatched"
          : "unknown",
    cleanup: "open",
    closed: false,
  };
  let candidateCount = 0;
  try {
    throwIfOperatorRequestCancelled();
    const extracted =
      afterAction === undefined
        ? await captureCredentialSource(sessionId, capture.source)
        : await captureCredentialSource(sessionId, capture.source, afterAction);
    candidateCount = extracted.candidate_count;
    if (extracted.resolved_from === "pre_action_only")
      // The source still resolves only as it did BEFORE the action — the
      // mutation has not rendered a changed source. Never store the pre-action
      // value (the Groq key-dialog failure); leave the write_id recoverable.
      return {
        ...base,
        execution: "completed",
        stored: false,
        storage: "unknown",
        error: "capture_pre_action_only",
        candidate_count: extracted.candidate_count,
        retry: "extract_only",
      };
    if (extracted.candidate_count !== 1 || extracted.value === undefined) {
      // Missing sources and single sources without a usable value share the
      // extraction-only recovery path; only multiple sources are ambiguous.
      const ambiguous = extracted.candidate_count > 1;
      return {
        ...base,
        execution: "completed",
        stored: false,
        error: ambiguous ? "capture_ambiguous" : "capture_unresolved",
        candidate_count: extracted.candidate_count,
        ...(ambiguous ? {} : { found: extracted.found ?? [] }),
        retry: "extract_only",
      };
    }
    const stored = await persistExtracted(
      sessionId,
      { api_key: extracted.value },
      capture.store,
      api,
      writeId,
    );
    if (stored === null) throw new Error("No credential to store");
    await persistOperatorCaptureEvidence({
      write_id: writeId,
      binding,
      stored: true,
      storage: "stored",
      reference: stored.reference,
    });
    return {
      ...base,
      execution: "completed",
      stored: true,
      stored_credential: stored,
      resolved_source: extracted.resolved_source ?? describeCaptureSource(capture.source),
    };
  } catch {
    // Errors may carry echoed provider values. Capture returns fixed metadata;
    // the page stays available for explicit reads and extraction-only recovery.
    return {
      ...base,
      execution: "unknown",
      stored: false,
      storage: "unknown",
      error: "capture_unresolved",
      candidate_count: candidateCount,
      found: [],
      retry: "extract_only",
    };
  }
}

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
  .refine((value) => Object.keys(value).length <= 12, "At most 12 selections per call")
  .describe(
    "Map each current browser-use DOM @e: ref or @label, or V1 observed label/ref, to its visible option text.",
  );

interface ExtractArgs {
  session_id: string;
  into_slot?: string | undefined;
  secret_label?: string | undefined;
  store?: StoreSpec | undefined;
}

async function handleExtract(args: ExtractArgs, api: ApiClient | null) {
  const extracted = await extractCredentials(args.session_id);

  // Slot transfer: capture the primary secret into a session-local slot so a
  // later type_secret can enter it into another site's form without the host
  // having to relay it. Mutually exclusive with store (a slotted secret is
  // being shuttled, not vaulted, in this call).
  if (args.into_slot !== undefined) {
    const values = extracted.credentials;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const candidates = Object.entries(values).filter(
      ([k, v]) => !k.endsWith("_truncated") && typeof v === "string" && v.length >= 8,
    );
    // A value that still LOOKS masked is never refused — it is simply ranked
    // last, so a fully revealed sibling wins when the page shows both.
    const ranked = [
      ...candidates.filter(([, v]) => !isMaskedDisplay(v)),
      ...candidates.filter(([, v]) => isMaskedDisplay(v)),
    ];
    // When the page shows several credentials (Google's client ID + secret),
    // a secret_label picks the right one by field name; otherwise take the
    // first full value. Falling back avoids a hard fail when the label misses.
    const wantKey = args.secret_label !== undefined ? norm(args.secret_label) : null;
    const matched = wantKey !== null ? ranked.find(([k]) => norm(k).includes(wantKey)) : undefined;
    const full = (matched ?? ranked[0])?.[1];
    if (typeof full !== "string" || full.length === 0) {
      return {
        session_id: extracted.session_id,
        url: extracted.url,
        candidate_count: extracted.candidate_count,
        sealed: false,
        slot: null,
        blocked_reason:
          "no credential value was found on this page — navigate to the keys/settings " +
          "page, then operate_extract again",
      };
    }
    const handle = stashSecretSlot(args.session_id, args.into_slot, full);
    return {
      session_id: extracted.session_id,
      url: extracted.url,
      candidate_count: extracted.candidate_count,
      sealed: true,
      slot: handle,
    };
  }

  if (args.store === undefined || Object.keys(extracted.credentials).length === 0) {
    return extracted;
  }
  if (api === null) {
    throw new Error("operate_extract store requires an active Trusty Squire session");
  }
  const stored = await persistExtracted(args.session_id, extracted.credentials, args.store, api);
  return storedExtractResult(extracted, stored);
}

const extractSchema = z.object({
  capture: captureSchema.optional(),
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
    "With `into_slot`, a value that still looks masked is ranked behind a fully " +
    "revealed sibling but never refused; pass " +
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
  writeId?: string,
): Promise<StoredCredentialMetadata | null> {
  credentials = Object.fromEntries(
    Object.entries(credentials).filter(([key]) => !key.endsWith("_truncated")),
  );
  if (!Object.keys(credentials).some((key) => key !== "id" && !key.endsWith("_id"))) {
    return null;
  }
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
    ...(writeId !== undefined ? { write_id: writeId } : {}),
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
 * Build the MCP-visible result of a storage attempt, including no usable credential.
 *
 * `ExtractResult.credentials` contains the raw values read from the browser. A
 * stored extraction must never spread that object back into the MCP response:
 * the host/model receives only non-secret extraction and vault metadata.
 */
export function storedExtractResult(
  extracted: ExtractResult,
  stored: StoredCredentialMetadata | null,
) {
  return {
    session_id: extracted.session_id,
    url: extracted.url,
    candidate_count: extracted.candidate_count,
    ...(extracted.blocked_reason !== undefined ? { blocked_reason: extracted.blocked_reason } : {}),
    stored_credential: stored,
  };
}

// Change 2 — the pluggable terminal. Two outcome kinds: `credentials` (the
// signup case — extract + vault-store, using the extraction tool's
// store path) and `result` (any operate task — a summary + optional structured
// data: design-review findings, "task done" with confirmed in data, etc.).
// operate_finish is the single terminal. `outcome.kind` picks the shape.
const finishDataSchema = z.record(z.union([z.string().max(4000), z.number(), z.boolean()]));

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
  let successfulOutcome = false;
  const { finish, prepared } = await finishProvisionSessionWithPreparation(
    sessionId,
    async () => {
      if (outcome.kind === "credentials") {
        await markOperatorMutationDispatchAttempted();
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
        successfulOutcome = stored !== null && blocked === undefined;
        emitProvisionMeasurement(sessionId, successfulOutcome ? "success" : "fail");
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
      successfulOutcome =
        outcome.verify_recipe === undefined ? false : verified?.confirmed === true;
      emitProvisionMeasurement(sessionId, successfulOutcome ? "success" : "fail");
      return {
        kind: "result" as const,
        summary: (outcome.summary ?? "").slice(0, 4000),
        ...(verified !== undefined ? { verified } : {}),
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    },
    () => successfulOutcome,
  );
  return { ...prepared, ...finish };
}

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

export const operateRecipeSaveTool: Tool<z.infer<typeof rememberSchema>> = {
  name: "operate_recipe_save",
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

export const operateRecipeRunTool: Tool<z.infer<typeof useSchema>> = {
  name: "operate_recipe_run",
  description:
    "Replay a local prepared-statement recipe selected by the host-classified closed-enum " +
    "verb plus service_url. Lookup uses eTLD+1 plus an allow-listed action path derived from " +
    "the URL path, then falls back to the eTLD+1 catch-all; query parameters are ignored. " +
    "A legacy name opens the " +
    "saved workflow as a planning hint without deterministic replay. Binds " +
    "hole values and executes each step through ordered target fallback. A single miss " +
    "returns replay.status='fallback_required' with that step and next_index; repair only " +
    "that step, then call operate_recipe_run again with the same params plus session_id + " +
    "resume_from=next_index. A recipe whose entry or declared hosts would leave its own " +
    "site (a tampered or malicious shared recipe) is refused outright: " +
    "replay.status='domain_lock_violation', and driving continues cold. " +
    "A recorded operate_pay step is never replayed and instead returns fallback_required so " +
    "the charge runs through a fresh, human-approved operate_pay. " +
    "Pass verb + session_id + leg:'checkout' (no service_url) to resolve+replay just the " +
    "CHECKOUT leg against an already-open session's current page — keyed by the checkout page's " +
    "own field-name-set signature, so a checkout plan recorded on one store can replay on a " +
    "different, unrelated store of the same checkout platform (cross-domain reuse). " +
    "replay.status='cache_miss' means no recipe matches this page's shape; drive the checkout " +
    "leg cold. A replay field failure on a recipe with a real catalog/storefront prefix " +
    "returns replay.status='leg_fallback_required' (not human_required): do not resume that " +
    "recipe; drive the checkout leg cold from from_step_index, and route any charge through " +
    "a fresh, human-approved operate_pay on the live session.",
  inputSchema: useSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      verb: { type: "string", enum: OperatorVerbSchema.options },
      service_url: { type: "string" },
      params: { type: "object" },
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
        ...(api !== null ? { api } : {}),
      });
      if (cold.needs_user !== undefined) return cold;
      return {
        ...cold,
        replay: {
          status: "cache_miss" as const,
          reason:
            "no local recipe for this action path or its (verb, eTLD+1) catch-all; continue cold",
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
        hint: renderOperatorRecipeHint(recipe),
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
    throw new Error("operate_login store_signup requires an active Trusty Squire session");
  }
  const login = readSecretSlotValue(args.session_id, args.login_slot ?? "login");
  const password = readSecretSlotValue(args.session_id, args.password_slot ?? "password");
  const observedHosts = observedHostsForSession(args.session_id);
  await markOperatorMutationDispatchAttempted();
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

const vaultCredentialFieldsDescription =
  'Exact field_names from list_credentials for the selected reference. Defaults to ["login","password"] ' +
  'for logins saved by operate_login; use ["username","password"] when those are the stored names. ' +
  "Use operate_type with each returned slot to fill its matching form control.";
const vaultCredentialFieldsJson = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 20,
  default: ["login", "password"],
  description: vaultCredentialFieldsDescription,
};

const sealVaultCredentialBaseSchema = z.object({
  session_id: z.string().min(1),
  reference: z.string().min(1).max(400).optional(),
  service: z.string().min(1).max(120).optional(),
  fields: z
    .array(z.string().min(1).max(120))
    .min(1)
    .max(20)
    .default(["login", "password"])
    .describe(vaultCredentialFieldsDescription),
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

export const operateFillCredentialTool: Tool<z.infer<typeof sealVaultCredentialSchema>> = {
  name: "operate_fill_credential",
  description:
    "For a sign-in page, retrieve a username/password credential only if the " +
    "current browser host is allowed for login, then seal requested fields into " +
    "session slots. Raw values are never returned; use operate_type with slot " +
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
      fields: vaultCredentialFieldsJson,
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
const loginOAuthSchema = z.object({
  session_id: z.string().min(1),
  action: z.literal("oauth").optional(),
  provider: z.enum(["google", "github"]),
  ref: z.string().min(1).max(200),
});
const loginSchema = z.union([
  loginOAuthSchema,
  loginPrepareSignupSchema,
  loginStoreSignupSchema,
  loginLoadSavedSchema,
]);

export const operateLoginTool: Tool<z.infer<typeof loginSchema>> = {
  name: "operate_login",
  description:
    "Log in with provider + ref using the atomic OAuth flow; awaiting-human state is returned in this call. After a dispatched timeout or error, completion may be unknown: retain session_id and call operate_observe before another action; do not repeat OAuth blindly. " +
    "Drive the sealed username/password login lifecycle without exposing raw values. " +
    "action='prepare_signup' seals the user's captured email and a generated password; " +
    "'store_signup' vaults those prepared slots with the same login-host safeguards; " +
    "'load_saved' fetches an allowed saved login through encrypted browser-fill and seals " +
    "its fields into session slots. Use operate_type with slot to fill returned slots.",
  inputSchema: loginSchema,
  jsonInputSchema: {
    type: "object",
    oneOf: [
      {
        required: ["session_id", "provider", "ref"],
        properties: {
          session_id: { type: "string" },
          action: { const: "oauth" },
          provider: { type: "string", enum: ["google", "github"] },
          ref: { type: "string" },
        },
      },
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
          fields: vaultCredentialFieldsJson,
          slot_prefix: { type: "string" },
        },
      },
    ],
  },
  async handler(args, api) {
    if ("provider" in args) {
      return await runAction(args.session_id, {
        kind: "oauth_login",
        provider: args.provider,
        target: args.ref,
      });
    }
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

// Every public verb delegates directly to the guarded session executor.
// This is a function, not a second Tool definition or public union schema.
async function runAction(
  sessionId: string,
  action: ProvisionAction,
  outputFormat: "compact" | "full" = "full",
  compactMapEmitted = true,
) {
  if (action.kind === "type") {
    const reason = manualCardEntryBlockReason(action.text);
    if (reason !== null)
      return {
        status: "manual_card_entry_refused",
        reason,
        safe_alternative: "operate_pay",
        missing_prerequisite: "verified_cart_total",
      };
  }
  try {
    return await act(sessionId, action, "compact", undefined, outputFormat, compactMapEmitted);
  } catch (error) {
    if (error instanceof TargetStaleError) return error.result;
    throw error;
  }
}

const sessionShape = { session_id: z.string().min(1) };
const refSchema = z.string().min(1).max(200);
const sessionJson = { session_id: { type: "string" } };
const refJson = { ref: { type: "string" } };

const navigateSchema = z.object({ ...sessionShape, url: z.string().url() });
export const operateNavigateTool: Tool<z.infer<typeof navigateSchema>> = {
  name: "operate_navigate",
  description:
    "Navigate to a URL without session host restrictions. Squire control-plane destinations remain refused.",
  inputSchema: navigateSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "url"],
    properties: { ...sessionJson, url: { type: "string", format: "uri" } },
  },
  handler: async (args) => await runAction(args.session_id, { kind: "goto", url: args.url }),
};

const screenshotPointSchema = z
  .object({
    screenshot_id: z.string().uuid(),
    x: z.number().finite().min(0),
    y: z.number().finite().min(0),
  })
  .strict();
const clickSchema = z
  .object({
    ...sessionShape,
    ref: refSchema.optional(),
    screenshot: screenshotPointSchema.optional(),
    capture: captureSchema.optional(),
    format: actionFormatSchema.optional(),
  })
  .refine((args) => (args.ref !== undefined) !== (args.screenshot !== undefined), {
    message: "Provide exactly one of ref or screenshot",
  });
export const operateClickTool: Tool<z.infer<typeof clickSchema>> = {
  name: "operate_click",
  description:
    ACTION_FORMAT_NOTE +
    "Prefer a current observation ref or unique @label. If a screenshot-visible control has no usable ref, pass screenshot:{screenshot_id,x,y} from operate_screenshot.click_binding, in original image pixels. Provide exactly one of ref or screenshot. target_unresolved means the label was never issued in this document; stale_ref means its reference or alias expired. stale_screenshot requires a new image. Each image binding permits one attempt; after an uncertain click, observe before deciding any new action. Dispatch does not guarantee challenge clearance. Card charges require operate_pay. A pointer-interception failure may use guarded DOM dispatch internally only when the executor proves no click was dispatched.",
  inputSchema: clickSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    oneOf: [
      { required: ["ref"], not: { required: ["screenshot"] } },
      { required: ["screenshot"], not: { required: ["ref"] } },
    ],
    properties: {
      ...sessionJson,
      ...refJson,
      format: actionFormatJson,
      screenshot: {
        type: "object",
        additionalProperties: false,
        required: ["screenshot_id", "x", "y"],
        properties: {
          screenshot_id: { type: "string", format: "uuid" },
          x: { type: "number", minimum: 0 },
          y: { type: "number", minimum: 0 },
        },
      },
    },
  },
  async handler(args) {
    const action = {
      kind: "click" as const,
      target: args.ref ?? "<screenshot-point>",
      ...(args.screenshot ? { screenshot: args.screenshot } : {}),
    };
    try {
      const result = await runAction(args.session_id, action, args.format ?? "compact");
      return args.screenshot
        ? {
            ...result,
            screenshot_click: {
              dispatch: "dispatched",
              outcome: "unknown",
              retry_policy: "observe_before_new_action",
            },
          }
        : result;
    } catch (error) {
      if (args.screenshot) {
        if (error instanceof ScreenshotClickError)
          return {
            status: error.code,
            screenshot_click: {
              dispatch: error.dispatch,
              outcome: "unknown",
              retry_policy:
                error.dispatch === "not_dispatched"
                  ? "capture_new_screenshot"
                  : "observe_before_new_action",
            },
          };
        throw error; // Coordinate dispatch never falls through to a second click.
      }
      // Require positive executor evidence: old interception log lines can remain
      // in an error even after a later click dispatched. Text alone is not proof.
      // Unknown failures, stale refs and payment refusals must never double-click.
      if (
        !(error instanceof Error) ||
        clickDispatchStatusForError(error) !== "not_dispatched" ||
        !/intercepts pointer events/.test(error.message)
      )
        throw error;
      return await runAction(
        args.session_id,
        { ...action, kind: "js_click" },
        args.format ?? "compact",
      );
    }
  },
};

const typeSchema = z
  .object({
    ...sessionShape,
    ref: refSchema,
    text: z.string().max(4096).optional(),
    slot: z.string().min(1).max(60).optional(),
    submit: z.boolean().optional(),
    capture: captureSchema.optional(),
    format: actionFormatSchema.optional(),
  })
  .refine((args) => (args.text !== undefined) !== (args.slot !== undefined), {
    message: "Provide exactly one of text or slot",
  });
export const operateTypeTool: Tool<z.infer<typeof typeSchema>> = {
  name: "operate_type",
  description:
    ACTION_FORMAT_NOTE +
    "Fill a control with text, or a session slot returned by operate_login, operate_fill_credential, or operate_extract. Provide exactly one of text or slot. submit presses Enter after a successful fill. Model-supplied card-number-shaped text is refused; use operate_pay.",
  inputSchema: typeSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "ref"],
    oneOf: [
      { required: ["text"], not: { required: ["slot"] } },
      { required: ["slot"], not: { required: ["text"] } },
    ],
    properties: {
      ...sessionJson,
      ...refJson,
      text: { type: "string" },
      slot: { type: "string" },
      submit: { type: "boolean" },
      format: actionFormatJson,
    },
  },
  async handler(args) {
    const result = await runAction(
      args.session_id,
      {
        target: args.ref,
        ...(args.slot !== undefined
          ? { kind: "type_secret" as const, slot: args.slot }
          : { kind: "type" as const, text: args.text! }),
      },
      args.format ?? "compact",
      args.submit !== true,
    );
    if (
      args.submit !== true ||
      (typeof result === "object" &&
        result !== null &&
        ("status" in result || "needs_user" in result))
    )
      return result;
    return await runAction(
      args.session_id,
      { kind: "press", key: "Enter" },
      args.format ?? "compact",
    );
  },
};

const selectSchema = z
  .object({
    ...sessionShape,
    ref: refSchema.optional(),
    values: z.array(z.string().min(1).max(4096)).length(1).optional(),
    selections: formSelectionsSchema.optional(),
    capture: captureSchema.optional(),
    country: z.string().min(1).max(60).optional(),
    format: actionFormatSchema.optional(),
  })
  .superRefine((args, ctx) => {
    const modes =
      Number(args.ref !== undefined || args.values !== undefined) +
      Number(args.selections !== undefined) +
      Number(args.country !== undefined);
    if (modes !== 1 || (args.ref !== undefined) !== (args.values !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide ref + values, selections, or country",
      });
    }
  });
export const operateSelectTool: Tool<z.infer<typeof selectSchema>> = {
  name: "operate_select",
  description:
    ACTION_FORMAT_NOTE +
    "Choose an option by visible text with ref + values (one value per control). For several controls, supply an ordered selections map of ref to option; partial results are retained. country selects the phone field's native country dropdown.",
  inputSchema: selectSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    oneOf: [
      {
        required: ["ref", "values"],
        not: { anyOf: [{ required: ["selections"] }, { required: ["country"] }] },
      },
      {
        required: ["selections"],
        not: {
          anyOf: [{ required: ["ref"] }, { required: ["values"] }, { required: ["country"] }],
        },
      },
      {
        required: ["country"],
        not: {
          anyOf: [{ required: ["ref"] }, { required: ["values"] }, { required: ["selections"] }],
        },
      },
    ],
    properties: {
      ...sessionJson,
      ...refJson,
      values: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 },
      selections: { type: "object", additionalProperties: { type: "string" } },
      country: { type: "string" },
      format: actionFormatJson,
    },
  },
  async handler(args) {
    if (args.selections !== undefined) {
      return await formSelectMany(args.session_id, args.selections, args.format ?? "compact");
    }
    if (args.country !== undefined)
      return await runAction(
        args.session_id,
        { kind: "set_phone_country", country: args.country },
        args.format ?? "compact",
      );
    return await runAction(
      args.session_id,
      {
        kind: "select",
        target: args.ref!,
        text: args.values![0]!,
      },
      args.format ?? "compact",
    );
  },
};

const pressSchema = z.object({
  ...sessionShape,
  key: z.string().min(1).max(40),
  capture: captureSchema.optional(),
  format: actionFormatSchema.optional(),
});
export const operatePressTool: Tool<z.infer<typeof pressSchema>> = {
  name: "operate_press",
  description:
    ACTION_FORMAT_NOTE +
    "Press a keyboard key in the current session, such as Enter, Tab, or Escape.",
  inputSchema: pressSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "key"],
    properties: {
      ...sessionJson,
      key: { type: "string" },
      format: actionFormatJson,
    },
  },
  handler: async (args) =>
    await runAction(args.session_id, { kind: "press", key: args.key }, args.format ?? "compact"),
};

const scrollSchema = z.object({
  ...sessionShape,
  direction: z.enum(["down", "up", "bottom", "top"]).default("down"),
  format: actionFormatSchema.optional(),
});
export const operateScrollTool: Tool<z.infer<typeof scrollSchema>> = {
  name: "operate_scroll",
  description:
    ACTION_FORMAT_NOTE +
    "Scroll the page viewport down, up, to the bottom, or to the top. Observe again to discover newly visible controls.",
  inputSchema: scrollSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      ...sessionJson,
      direction: { type: "string", enum: ["down", "up", "bottom", "top"], default: "down" },
      format: actionFormatJson,
    },
  },
  handler: async (args) =>
    await runAction(
      args.session_id,
      { kind: "scroll", direction: args.direction },
      args.format ?? "compact",
    ),
};

const allowHostSchema = z.object({ ...sessionShape, host: z.string().min(1).max(253) });
export const operateAllowHostTool: Tool<z.infer<typeof allowHostSchema>> = {
  name: "operate_allow_host",
  description:
    "Compatibility no-op. Browser egress is unrestricted; no host declaration is needed.",
  inputSchema: allowHostSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "host"],
    properties: { ...sessionJson, host: { type: "string" } },
  },
  async handler(args) {
    const session = sessionForCall(args.session_id);
    if (session === undefined) throw new Error(`unknown provision session ${args.session_id}`);
    return await runAction(args.session_id, { kind: "allow_host", host: args.host });
  },
};

// A flat completion schema retains terminal preparation and teardown.
const publicFinishSchema = z
  .object({
    ...sessionShape,
    outcome: z.enum(["none", "credentials", "result"]).default("none"),
    store: storeShape.optional(),
    summary: z.string().max(4000).optional(),
    data: finishDataSchema.optional(),
    verify_recipe: z.string().min(1).max(80).optional(),
  })
  .superRefine((args, ctx) => {
    if (args.outcome === "credentials" && args.store === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "credentials outcome requires store" });
    if (args.outcome === "result" && args.summary === undefined && args.data === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "result outcome requires summary or data",
      });
  });
export const operateFinishTool: Tool<z.infer<typeof publicFinishSchema>> = {
  name: "operate_finish",
  jsonOutputSchema: {
    type: "object",
    required: ["session_id", "operation_id", "execution", "mutation", "cleanup", "closed"],
    properties: {
      session_id: { type: "string" },
      operation_id: { type: "string" },
      execution: { type: "string", enum: ["completed", "cancelled", "pending", "unknown"] },
      mutation: { type: "string", enum: ["not_dispatched", "dispatched", "unknown"] },
      cleanup: { type: "string", enum: ["open", "closing", "closed", "already_closed", "unknown"] },
      closed: { type: "boolean" },
      data: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
    },
    additionalProperties: true,
  },
  description:
    "Finish the task and close its session. outcome='none' closes without a reported outcome; 'credentials' extracts and vault-stores using store; 'result' reports summary or data. Success requires verified recipe evidence; agent data.confirmed is not authoritative. Successful completion saves eligible login state through the existing teardown.",
  inputSchema: publicFinishSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      ...sessionJson,
      outcome: { type: "string", enum: ["none", "credentials", "result"], default: "none" },
      store: { type: "object", required: ["service"], properties: storeJsonProps },
      summary: { type: "string" },
      data: { type: "object" },
      verify_recipe: { type: "string" },
    },
    allOf: [
      {
        if: { required: ["outcome"], properties: { outcome: { const: "credentials" } } },
        then: { required: ["store"] },
      },
      {
        if: { required: ["outcome"], properties: { outcome: { const: "result" } } },
        then: { anyOf: [{ required: ["summary"] }, { required: ["data"] }] },
      },
    ],
  },
  async handler(args, api) {
    const outcome = finishOutcomeSchema.parse({ ...args, kind: args.outcome });
    if (outcome.kind === "none") return await finishProvisionSession(args.session_id);
    if (outcome.kind === "credentials" && api === null)
      throw new Error("operate_finish credentials requires an active Trusty Squire session");
    return await handleFinishOutcome(args.session_id, outcome, api as ApiClient);
  },
};

// The named target contains 18 tools including the two payment and two vault
// tools registered in index.ts. Recipe tools and the rest of the vault surface
// are unchanged and are outside that target set.
export const OPERATE_TOOLS: Tool[] = [
  provisionStartTool,
  operateFinishTool,
  provisionObserveTool,
  provisionScreenshotTool,
  provisionNetworkTool,
  operateNavigateTool,
  operateClickTool,
  operateTypeTool,
  operateSelectTool,
  operatePressTool,
  operateScrollTool,
  operateAllowHostTool,
  operateLoginTool,
  operateFillCredentialTool,
  provisionExtractTool,
  operateRecipeSaveTool,
  operateRecipeRunTool,
] as Tool[];

const captureOutputSchema = {
  type: "object" as const,
  properties: {
    session_id: { type: "string" },
    operation_id: { type: "string" },
    write_id: { type: "string" },
    execution: { enum: ["completed", "cancelled", "pending", "unknown"] },
    mutation: { enum: ["not_dispatched", "dispatched", "unknown"] },
    cleanup: { enum: ["open", "closing", "closed", "already_closed", "unknown"] },
    closed: { type: "boolean" },
    stored: { type: "boolean" },
    storage: { enum: ["stored", "unknown", "not_attempted"] },
    stored_credential: {
      type: "object",
      properties: { reference: { type: "string" } },
      additionalProperties: true,
    },
    resolved_source: {
      type: "object",
      description: "Names the element the vaulted value was resolved from (role/name or selector).",
      additionalProperties: true,
    },
    candidate_count: { type: "integer" },
    found: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["role"],
        additionalProperties: false,
        properties: {
          role: { type: "string" },
          name: { type: ["string", "null"] },
        },
      },
    },
    action_result: { type: "object", additionalProperties: true },
    retry: { enum: ["extract_only", "action"] },
  },
  additionalProperties: true,
};

for (const tool of OPERATE_TOOLS) {
  if (
    ![
      "operate_click",
      "operate_type",
      "operate_select",
      "operate_press",
      "operate_extract",
    ].includes(tool.name)
  )
    continue;
  const properties = tool.jsonInputSchema.properties;
  if (properties !== null && typeof properties === "object")
    Object.assign(properties, { capture: captureJson });
  tool.description +=
    " Optional capture:{store,source:{role,name?,container?}|{selector,container?}} vaults exactly one revealed source and returns metadata only; the source is resolved against the document AFTER the action's mutation settles, and a stored result names the resolved element in resolved_source. Use a value-free CSS selector for a plain-text copy field without a textbox/code role. Resolution pierces open shadow roots: a bare selector, a role, or a cross-shadow [container] descendant selector all reach shadow-hosted fields (e.g. Groq's id-less created-key <input> inside an open shadow root); when the role is textbox, an id-less text input whose value looks secret-shaped also matches if it is the only textbox in the container/document. A source matching nothing returns error capture_unresolved with candidate_count 0 and a found list of the roles/names that DID render (never values) — use it to pick the next source; capture_ambiguous is reserved for more than one match. If storage is unresolved, retry operate_extract with capture.write_id; never repeat creation. An unresolved capture does not block unrelated actions — only a new vaulting attempt and a credentials finish stay fenced.";
  tool.jsonOutputSchema = captureOutputSchema;
  const handler = tool.handler;
  tool.handler = async (args, api, context) => {
    if (args.capture === undefined) return await handler(args, api, context);
    if (api === null) throw new Error("capture requires an active Trusty Squire session");
    const capture = captureSchema.parse(args.capture);
    if (typeof args.session_id !== "string") throw new Error("capture requires a session");
    const recovery = capture.write_id !== undefined;
    if (tool.name !== "operate_extract" && recovery)
      throw new Error("capture.write_id is for extraction-only recovery, not another mutation");
    const writeId = capture.write_id ?? currentOperatorOperationId() ?? randomUUID();
    capture.write_id = writeId;
    const binding = createHash("sha256")
      .update(JSON.stringify([capture.store.service, capture.store.label ?? null]))
      .digest("hex");
    await persistOperatorCaptureEvidence(
      { write_id: writeId, binding, stored: false, storage: "unknown" },
      recovery,
    );
    if (tool.name !== "operate_extract") {
      let actionResult: unknown;
      // A click capture must be judged against the POST-action document. Probe
      // the source BEFORE the click so the post-action resolution can prove it
      // is not merely the pre-click element re-read (the Groq key-dialog
      // failure, where the only pre-click textbox was the display-name input).
      // A probe failure never blocks the click itself.
      const preProbe =
        tool.name === "operate_click"
          ? await probeCaptureSource(args.session_id, capture.source).catch(() => undefined)
          : undefined;
      try {
        actionResult = await handler(args, api, context);
        if (
          !(
            actionResult !== null &&
            typeof actionResult === "object" &&
            ("status" in actionResult || "needs_user" in actionResult)
          )
        )
          return {
            ...(await captureIntoVault(
              args.session_id,
              capture,
              api,
              tool.name === "operate_click" ? { pre: preProbe } : undefined,
            )),
            ...(actionResult !== null &&
            typeof actionResult === "object" &&
            "screenshot_click" in actionResult
              ? { screenshot_click: actionResult.screenshot_click }
              : {}),
          };
      } catch {
        actionResult = undefined;
      } finally {
        const baseline = sessionForCall(args.session_id)?.compactV2Previous;
        if (baseline) delete baseline.compactMapEmitted;
        if (preProbe?.handle !== undefined) await preProbe.handle.dispose().catch(() => undefined);
      }
      const notDispatched = operatorMutationDispatchPhase() === "prepared";
      if (notDispatched)
        await persistOperatorCaptureEvidence({
          write_id: writeId,
          binding,
          stored: false,
          storage: "not_attempted",
        });
      return {
        ...(actionResult !== null && typeof actionResult === "object" ? actionResult : {}),
        action_result: actionResult,
        session_id: args.session_id,
        operation_id: currentOperatorOperationId() ?? writeId,
        write_id: writeId,
        mutation: notDispatched ? "not_dispatched" : "unknown",
        execution: actionResult === undefined ? "unknown" : "completed",
        cleanup: "open",
        closed: false,
        stored: false,
        storage: notDispatched ? "not_attempted" : "unknown",
        error: "capture_action_unresolved",
        retry: notDispatched ? "action" : "extract_only",
      };
    }
    return await captureIntoVault(args.session_id, capture, api);
  };
}

// Keep the additive click receipt discoverable alongside the shared capture result.
operateClickTool.jsonOutputSchema = {
  ...captureOutputSchema,
  properties: {
    ...captureOutputSchema.properties,
    screenshot_click: {
      type: "object",
      required: ["dispatch", "outcome", "retry_policy"],
      properties: {
        dispatch: { enum: ["dispatched", "not_dispatched", "unknown"] },
        outcome: { const: "unknown" },
        retry_policy: { enum: ["observe_before_new_action", "capture_new_screenshot"] },
      },
    },
  },
};
