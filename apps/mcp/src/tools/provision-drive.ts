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
  extractCredentials,
  captchaGate,
  awaitVerification,
  finishProvisionSession,
  observedHostsForSession,
  currentProvisionUrl,
  stashSecretSlot,
  readSecretSlotValue,
  getSessionUserEmail,
  generatePassword,
  rememberRecipe,
  verifyPostcondition,
  type ProvisionAction,
} from "../bot/provision-session.js";
import {
  readRecipe,
  renderOperatorRecipeHint,
  recipeEntryUrl,
  fillTemplate,
  PostconditionSchema,
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

// Best-effort: ask the registry for a known route for this service so the agent
// drives on rails instead of ad-hoc. Returns undefined on any miss (no skill,
// no registry configured, network error) — the agent just drives without it.
async function resolveRouteHint(serviceUrl: string): Promise<string | undefined> {
  try {
    const accountId = process.env.TRUSTY_SQUIRE_ACCOUNT_ID;
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

export const provisionStartTool: Tool<z.infer<typeof startSchema>> = {
  name: "operate_start",
  description:
    "Begin an interactive provisioning session: opens a scoped browser on the " +
    "user's machine at service_url and returns {session_id, url, text, screen, " +
    "accessibility, elements}. " +
    "YOU are the planner — read the observation, then drive the signup with " +
    "operate_act, re-read with operate_observe, and call operate_extract " +
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
  // Payload verbosity. Default "compact" (text + actionable elements, ~50%
  // smaller). Pass "full" for the legacy screen+accessibility+full-field payload
  // on a genuinely ambiguous step.
  detail: z.enum(["compact", "full"]).optional(),
});

export const provisionObserveTool: Tool<z.infer<typeof observeSchema>> = {
  name: "operate_observe",
  description:
    "Re-read the current page of a provisioning session. DEFAULT is a COMPACT " +
    "payload: {url, text, elements} where each element has a fresh `ref` (pass as " +
    "operate_act.target) plus label/role/href/path/value_len — empty fields and " +
    "the redundant screen/accessibility trees are omitted (~50% smaller). Pass " +
    "detail:\"full\" for the legacy screen+accessibility+full-field payload on a " +
    "genuinely ambiguous step. Refs are scoped to the latest observation; stale " +
    "refs fail loudly, so re-observe and retry with the new ref.",
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

const actSchema = z.object({
  session_id: z.string().min(1),
  kind: z.enum([
    "click", "js_click", "type", "goto", "press", "oauth_click", "oauth_settle",
    "allow_host", "type_secret", "scroll",
  ]),
  target: z.string().min(1).max(200).optional(),
  text: z.string().max(4096).optional(),
  url: z.string().url().optional(),
  key: z.string().min(1).max(40).optional(),
  // allow_host: a bare hostname to cross into mid-session.
  host: z.string().min(1).max(253).optional(),
  // type_secret: the sealed slot whose value to type into `target`.
  slot: z.string().min(1).max(60).optional(),
  // scroll: which way to move the viewport (default "down").
  direction: z.enum(["down", "up", "bottom", "top"]).optional(),
  // How much perception to return AFTER the action (the same ladder as
  // operate_observe, plus "none"). "none" = a minimal ack (action ran; no page
  // dump) for chained fills — call operate_observe before the next ref-targeted
  // act. "full" = the legacy payload. Default "compact".
  detail: z.enum(["none", "compact", "full"]).optional(),
});

function buildAction(args: z.infer<typeof actSchema>): ProvisionAction {
  const need = (v: string | undefined, name: string): string => {
    if (v === undefined || v.length === 0) {
      throw new Error(`operate_act kind="${args.kind}" requires "${name}"`);
    }
    return v;
  };
  switch (args.kind) {
    case "click":
      return { kind: "click", target: need(args.target, "target") };
    case "js_click":
      return { kind: "js_click", target: need(args.target, "target") };
    case "oauth_click":
      return { kind: "oauth_click", target: need(args.target, "target") };
    case "type":
      return { kind: "type", target: need(args.target, "target"), text: args.text ?? "" };
    case "goto":
      return { kind: "goto", url: need(args.url, "url") };
    case "press":
      return { kind: "press", key: need(args.key, "key") };
    case "oauth_settle":
      return { kind: "oauth_settle" };
    case "allow_host":
      return { kind: "allow_host", host: need(args.host, "host") };
    case "type_secret":
      return { kind: "type_secret", slot: need(args.slot, "slot"), target: need(args.target, "target") };
    case "scroll":
      return { kind: "scroll", ...(args.direction !== undefined ? { direction: args.direction } : {}) };
  }
}

export const provisionActTool: Tool<z.infer<typeof actSchema>> = {
  name: "operate_act",
  description:
    "Take one action in a provisioning session, then return the resulting " +
    "observation. kinds: click (target=element ref, preferably elements[].ref), type (target + text), " +
    "goto (url — domain-scoped), press (key, e.g. Enter), oauth_click (target — " +
    "use for 'Continue with Google/GitHub' so the popup is adopted), " +
    "oauth_settle (return to the product page after the OAuth handshake), " +
    "allow_host (host — cross into another app's domain mid-task, e.g. from the " +
    "GCP console into Firebase), type_secret (slot + target — type a secret you " +
    "captured into a sealed slot via operate_extract{into_slot} into a field " +
    "on the current site; the value never leaves the browser), scroll (direction " +
    "down/up/bottom/top, default down — reveal below-the-fold controls on a long " +
    "form, then operate_observe to pick up the newly-visible elements). If a " +
    "target ref is stale, call operate_observe and retry with a fresh ref. " +
    "detail (default \"compact\") controls the returned payload: \"none\" skips it " +
    "entirely for chained fills (then operate_observe before the next ref action), " +
    "\"full\" returns the legacy screen+accessibility payload.",
  inputSchema: actSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "kind"],
    properties: {
      session_id: { type: "string" },
      kind: {
        type: "string",
        enum: [
          "click", "js_click", "type", "goto", "press", "oauth_click", "oauth_settle",
          "allow_host", "type_secret", "scroll",
        ],
      },
      target: { type: "string" },
      text: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
      host: { type: "string" },
      slot: { type: "string" },
      direction: { type: "string", enum: ["down", "up", "bottom", "top"] },
      detail: { type: "string", enum: ["none", "compact", "full"] },
    },
  },
  async handler(args) {
    return await act(args.session_id, buildAction(args), args.detail ?? "compact");
  },
};

// Shared "store this credential in the vault" shape — used by both the
// mid-session extract tool and the credentials terminal (operate_finish_task).
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

// Vault-store an extracted credential. Shared by extract + the credentials
// terminal so the stored record is byte-identical regardless of entry point.
async function persistExtracted(
  sessionId: string,
  credentials: Record<string, string>,
  store: StoreSpec,
  api: ApiClient,
): Promise<{ reference: string; service: string; label: string | undefined; field_names: string[]; allowed_hosts: string[]; updated: boolean }> {
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
    ...(store.env_var_suggestion !== undefined ? { env_var_suggestion: store.env_var_suggestion } : {}),
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

const extractSchema = z.object({
  session_id: z.string().min(1),
  // Sealed transfer: stash the extracted secret in a session-local slot and
  // return ONLY a masked handle (never the value), so a later type_secret can
  // enter it into another site's form without the value crossing to the host.
  into_slot: z.string().min(1).max(60).optional(),
  // Disambiguate WHICH credential to seal when the page shows several (Google's
  // OAuth dialog has both a client ID and a client secret). Matches the
  // credential's field label, e.g. "client secret" / "secret". Omit when there's
  // only one.
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
    "observed hosts as allowed_hosts seed. If `blocked_reason` is set, " +
    "the page is a login wall / anti-bot interstitial with NO credential present " +
    "(do not treat the empty result as a real key) — drive an interactive login " +
    "or hand back to the user. Call when you have navigated to the keys page. " +
    "With `into_slot`, a still-masked value is refused (reveal it first); pass " +
    "`secret_label` (e.g. \"client secret\") to pick the right one when the page " +
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
  async handler(args, api) {
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
            "show/reveal/copy control near the key), then operate_extract again",
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
        ...(extracted.blocked_reason !== undefined ? { blocked_reason: extracted.blocked_reason } : {}),
      };
    }

    if (args.store === undefined || Object.keys(extracted.credentials).length === 0) {
      return extracted;
    }
    if (api === null) {
      throw new Error("operate_extract store requires an active Trusty Squire session");
    }
    const stored = await persistExtracted(args.session_id, extracted.credentials, args.store, api);
    return { ...extracted, stored_credential: stored };
  },
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
  async handler(args) {
    return await captchaGate(args.session_id);
  },
};

const verifySchema = z.object({
  session_id: z.string().min(1),
  sender: z.string().min(1).max(120).optional(),
  // Seal a found OTP into this slot instead of returning it — then enter it
  // with operate_act{type_secret, slot}. The code never reaches you (safer, and
  // it dodges client-side payload truncation).
  into_slot: z.string().min(1).max(60).optional(),
  // PR3b — set true ONLY after the user agrees, in context, to let the operator
  // read their inbox for this signup. Grants inbox-read for the rest of this
  // session and proceeds to read. Never set this without an explicit user yes.
  grant_inbox_consent: z.boolean().optional(),
});

export const provisionAwaitVerificationTool: Tool<z.infer<typeof verifySchema>> = {
  name: "operate_await_verification",
  description:
    "Read the user's OWN inbox through their signed-in browser session (no IMAP, " +
    "no mail token) to complete email verification: returns {found, code, link, " +
    "needs_user?}. Pass `sender` (e.g. 'resend.com') to scope the search. On " +
    "found=true, type the code with operate_act or goto the link. PREFER passing " +
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
  async handler(args) {
    return await awaitVerification(args.session_id, {
      ...(args.sender !== undefined ? { sender: args.sender } : {}),
      ...(args.into_slot !== undefined ? { intoSlot: args.into_slot } : {}),
      ...(args.grant_inbox_consent === true ? { grantConsent: true } : {}),
    });
  },
};

// Change 2 — the pluggable terminal. Two outcome kinds: `credentials` (the
// signup case — extract + vault-store, byte-identical to operate_extract's
// store path) and `result` (any operate task — a summary + optional structured
// data: design-review findings, "task done" with confirmed in data, etc.).
// Both close the session. `operate_finish` stays for abort/give-up.
const finishTaskSchema = z.object({
  session_id: z.string().min(1),
  kind: z.enum(["credentials", "result"]),
  // credentials kind: where to vault the extracted key (same shape as extract).
  store: storeShape.optional(),
  // result kind: a human-readable outcome + optional bounded structured data.
  summary: z.string().max(4000).optional(),
  data: z.record(z.string().max(4000)).optional(),
  // result kind: verify a saved operator-recipe's postcondition before closing
  // (the anti-false-green gate). `verified.confirmed` reflects the machine check.
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
    "data). Use operate_finish instead to abort without an outcome.",
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
      const extracted = await extractCredentials(args.session_id);
      if (args.store === undefined) {
        throw new Error("operate_finish_task kind=credentials requires `store`");
      }
      if (api === null) {
        throw new Error("operate_finish_task credentials requires an active Trusty Squire session");
      }
      const blocked = extracted.blocked_reason;
      const stored =
        Object.keys(extracted.credentials).length > 0
          ? await persistExtracted(args.session_id, extracted.credentials, args.store, api)
          : null;
      const closed = await finishProvisionSession(args.session_id);
      return {
        kind: "credentials" as const,
        url: closed.url,
        candidate_count: extracted.candidate_count,
        ...(blocked !== undefined ? { blocked_reason: blocked } : {}),
        stored_credential: stored,
      };
    }
    // result kind — optionally verify a saved recipe's postcondition (the
    // anti-false-green gate) against the live session BEFORE closing, then close.
    const verified =
      args.verify_recipe !== undefined
        ? await verifyPostcondition(args.session_id, (await readRecipe(args.verify_recipe)).postcondition)
        : undefined;
    const closed = await finishProvisionSession(args.session_id);
    return {
      kind: "result" as const,
      url: closed.url,
      summary: (args.summary ?? "").slice(0, 4000),
      ...(verified !== undefined ? { verified } : {}),
      ...(args.data !== undefined ? { data: args.data } : {}),
    };
  },
};

const finishSchema = z.object({ session_id: z.string().min(1) });

export const provisionFinishTool: Tool<z.infer<typeof finishSchema>> = {
  name: "operate_finish",
  description:
    "Close a provisioning session and tear down its browser. Always call this " +
    "when the run is complete (success or give-up) to release the browser.",
  inputSchema: finishSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: { session_id: { type: "string" } },
  },
  async handler(args) {
    return await finishProvisionSession(args.session_id);
  },
};

// ── operator-recipe tools (Phase A — docs/ARCHITECTURE.md) ──

const rememberSchema = z.object({
  session_id: z.string().min(1),
  name: z.string().min(1).max(80),
  goal: z.string().min(1).max(300),
  postcondition: PostconditionSchema,
});

export const provisionRememberTool: Tool<z.infer<typeof rememberSchema>> = {
  name: "operate_remember",
  description:
    "Save the CURRENT successful operate session as a replayable operator-recipe " +
    "(local, named). Pass `name`, a one-line `goal`, and a `postcondition` — the " +
    "machine-checkable success signal: kind 'execute_capability' observes the " +
    "end-state now; `success_signal` is {field_text,min_value_len} (a field whose " +
    "value is at least N chars — checked by LENGTH, never the value), {text_present}, " +
    "or {url_contains}. The recipe stores the session's TEXT-targeted action trace " +
    "as a rail; sealed secrets become slot references, NEVER values. Call AFTER the " +
    "task succeeded; replay later with operate_use{name}.",
  inputSchema: rememberSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "name", "goal", "postcondition"],
    properties: {
      session_id: { type: "string" },
      name: { type: "string" },
      goal: { type: "string" },
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
    return await rememberRecipe(args.session_id, {
      name: args.name,
      goal: args.goal,
      postcondition: args.postcondition,
    });
  },
};

const useSchema = z.object({
  name: z.string().min(1).max(80),
  params: z.record(z.string().max(2000)).optional(),
  require_live_identity: z.boolean().optional(),
});

export const provisionUseTool: Tool<z.infer<typeof useSchema>> = {
  name: "operate_use",
  description:
    "Replay a saved operator-recipe by name: opens a scoped browser at the recipe's " +
    "entry and returns the start observation with the recipe's route as a `hint` — a " +
    "MAP to drive toward, NOT a literal script (re-plan if the live page diverges). " +
    "Fill ${VAR} entry templates via `params` (e.g. {PROJECT:'my-proj'}). Sealed " +
    "steps must be re-sealed + typed yourself (operate_extract{into_slot} → " +
    "type_secret) — the recipe never holds secret values. Drive the task, then " +
    "operate_finish_task{kind:'result', verify_recipe:<name>} to verify the " +
    "postcondition (the anti-false-green gate).",
  inputSchema: useSchema,
  jsonInputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      params: { type: "object" },
      require_live_identity: { type: "boolean" },
    },
  },
  async handler(args) {
    const recipe = await readRecipe(args.name);
    const entry = recipeEntryUrl(recipe);
    if (entry === null) {
      throw new Error(`operator-recipe "${args.name}" has no entry (goto) step to start from`);
    }
    const { url, missing } = fillTemplate(entry, args.params ?? {});
    if (missing.length > 0) {
      throw new Error(
        `operator-recipe "${args.name}" needs params: ${missing.join(", ")} — ` +
          `pass them as operate_use{ params: { ${missing.map((m) => `${m}: "..."`).join(", ")} } }`,
      );
    }
    const consentInboxRead = await readInboxConsent();
    return await startProvisionSession({
      serviceUrl: url,
      consentInboxRead,
      ...(recipe.allowed_hosts.length > 0 ? { extraAllowedHosts: recipe.allowed_hosts } : {}),
      hint: renderOperatorRecipeHint(recipe),
      ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
    });
  },
};

// PR3c — username/password signup credential lifecycle (no Trusty Squire alias).
const prepareLoginSchema = z.object({
  session_id: z.string().min(1),
  login_slot: z.string().min(1).max(60).optional(),
  password_slot: z.string().min(1).max(60).optional(),
  password_length: z.number().int().min(16).max(64).optional(),
});

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
  async handler(args) {
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
    return { session_id: args.session_id, slots: { login, password }, email_preview: login.preview };
  },
};

const storeLoginSchema = z.object({
  session_id: z.string().min(1),
  service: z.string().min(1).max(120),
  login_slot: z.string().min(1).max(60).optional(),
  password_slot: z.string().min(1).max(60).optional(),
  label: z.string().min(1).max(120).optional(),
  signin_url: z.string().url().optional(),
  login_hosts: z.array(z.string().min(1).max(253)).min(1).max(20),
});

export const provisionStoreLoginTool: Tool<z.infer<typeof storeLoginSchema>> = {
  name: "operate_store_login",
  description:
    "After the service account is created, vault the sealed signup login (the " +
    "user's email + the generated password from operate_prepare_login) as a " +
    "username_password credential so the user can sign back in. Reads the sealed " +
    "slots server-side; raw values are never returned to you. Pass the exact " +
    "login hosts where this credential may be filled; use *.example.com only " +
    "when subdomains are intentionally allowed.",
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
  async handler(args, api) {
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
      login_hosts: args.login_hosts,
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
  },
};

const sealVaultCredentialSchema = z
  .object({
    session_id: z.string().min(1),
    reference: z.string().min(1).max(400).optional(),
    service: z.string().min(1).max(120).optional(),
    fields: z.array(z.string().min(1).max(120)).min(1).max(20).default(["login", "password"]),
    slot_prefix: z.string().min(1).max(60).default("vault"),
  })
  .refine((b) => b.reference !== undefined || b.service !== undefined, {
    message: "one of reference or service is required",
  });

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
  async handler(args, api) {
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
  },
};

export const OPERATE_TOOLS: Tool[] = [
  provisionStartTool,
  provisionObserveTool,
  provisionActTool,
  provisionCaptchaGateTool,
  provisionAwaitVerificationTool,
  provisionExtractTool,
  provisionPrepareLoginTool,
  provisionStoreLoginTool,
  provisionSealVaultCredentialTool,
  provisionRememberTool,
  provisionUseTool,
  provisionFinishTaskTool,
  provisionFinishTool,
] as Tool[];
