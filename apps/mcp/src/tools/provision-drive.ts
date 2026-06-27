// Phase 1 — the interactive provisioning tool surface a frontier HOST agent
// drives. The host is the planner; these tools are the browser + the moat.
// Backed by ../bot/provision-session.ts (the session registry over the existing
// BrowserController substrate).
// Domain-scoping, the write-only-vault de-fang, and a per-action audit log are
// in place; the consent-at-install prompt is the remaining hardening.

import { z } from "zod";
import type { Tool } from "./index.js";
import {
  startProvisionSession,
  observe,
  act,
  extractCredentials,
  captchaGate,
  awaitVerification,
  finishProvisionSession,
  observedHostsForSession,
  stashSecretSlot,
  type ProvisionAction,
} from "../bot/provision-session.js";
import { renderSkillHint, serviceSlugFromUrl } from "../bot/skill-hint.js";
import { clientFromEnv, generateProvisionId } from "../skill-registry-client.js";

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
  name: "provision_start",
  description:
    "Begin an interactive provisioning session: opens a scoped browser on the " +
    "user's machine at service_url and returns {session_id, url, text, screen, " +
    "accessibility, elements}. " +
    "YOU are the planner — read the observation, then drive the signup with " +
    "provision_act, re-read with provision_observe, and call provision_extract " +
    "when you reach the credentials. Always provision_finish when done. The " +
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
  async handler(args) {
    const hint = await resolveRouteHint(args.service_url);
    const extra = [...(args.allowed_hosts ?? []), ...(args.extra_allowed_hosts ?? [])];
    return await startProvisionSession({
      serviceUrl: args.service_url,
      ...(extra.length > 0 ? { extraAllowedHosts: extra } : {}),
      ...(args.require_live_identity === true ? { requireLiveIdentity: true } : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  },
};

const observeSchema = z.object({ session_id: z.string().min(1) });

export const provisionObserveTool: Tool<z.infer<typeof observeSchema>> = {
  name: "provision_observe",
  description:
    "Re-read the current page of a provisioning session: returns {url, text, " +
    "screen, accessibility, elements}. Each element has a fresh generated `ref` " +
    "to pass back as provision_act.target, plus `label`/`href` for reading. " +
    "Refs are scoped to the latest observation; stale refs fail loudly, so call " +
    "provision_observe and retry with the new ref. Legacy label targets still " +
    "work, but exact refs are safer on pages with repeated labels.",
  inputSchema: observeSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: { session_id: { type: "string" } },
  },
  async handler(args) {
    return await observe(args.session_id);
  },
};

const actSchema = z.object({
  session_id: z.string().min(1),
  kind: z.enum([
    "click", "js_click", "type", "goto", "press", "oauth_click", "oauth_settle",
    "allow_host", "type_secret",
  ]),
  target: z.string().min(1).max(200).optional(),
  text: z.string().max(4096).optional(),
  url: z.string().url().optional(),
  key: z.string().min(1).max(40).optional(),
  // allow_host: a bare hostname to cross into mid-session.
  host: z.string().min(1).max(253).optional(),
  // type_secret: the sealed slot whose value to type into `target`.
  slot: z.string().min(1).max(60).optional(),
});

function buildAction(args: z.infer<typeof actSchema>): ProvisionAction {
  const need = (v: string | undefined, name: string): string => {
    if (v === undefined || v.length === 0) {
      throw new Error(`provision_act kind="${args.kind}" requires "${name}"`);
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
  }
}

export const provisionActTool: Tool<z.infer<typeof actSchema>> = {
  name: "provision_act",
  description:
    "Take one action in a provisioning session, then return the resulting " +
    "observation. kinds: click (target=element ref, preferably elements[].ref), type (target + text), " +
    "goto (url — domain-scoped), press (key, e.g. Enter), oauth_click (target — " +
    "use for 'Continue with Google/GitHub' so the popup is adopted), " +
    "oauth_settle (return to the product page after the OAuth handshake), " +
    "allow_host (host — cross into another app's domain mid-task, e.g. from the " +
    "GCP console into Firebase), type_secret (slot + target — type a secret you " +
    "captured into a sealed slot via provision_extract{into_slot} into a field " +
    "on the current site; the value never leaves the browser). If a " +
    "target ref is stale, call provision_observe and retry with a fresh ref.",
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
          "allow_host", "type_secret",
        ],
      },
      target: { type: "string" },
      text: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
      host: { type: "string" },
      slot: { type: "string" },
    },
  },
  async handler(args) {
    return await act(args.session_id, buildAction(args));
  },
};

const extractSchema = z.object({
  session_id: z.string().min(1),
  // Sealed transfer: stash the extracted secret in a session-local slot and
  // return ONLY a masked handle (never the value), so a later type_secret can
  // enter it into another site's form without the value crossing to the host.
  into_slot: z.string().min(1).max(60).optional(),
  store: z
    .object({
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
    })
    .optional(),
});

export const provisionExtractTool: Tool<z.infer<typeof extractSchema>> = {
  name: "provision_extract",
  description:
    "Reveal masked keys and extract credentials from the current page: returns " +
    "{credentials, candidate_count, blocked_reason?}. credentials may include " +
    "`api_key` (or `api_key_truncated` if only a masked display was reachable) " +
    "plus named fields for multi-credential services. Pass `store` to immediately " +
    "save the extracted credential into the Trusty Squire vault with the session's " +
    "observed hosts as allowed_hosts seed. If `blocked_reason` is set, " +
    "the page is a login wall / anti-bot interstitial with NO credential present " +
    "(do not treat the empty result as a real key) — drive an interactive login " +
    "or hand back to the user. Call when you have navigated to the keys page.",
  inputSchema: extractSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      into_slot: { type: "string" },
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
      const primary = values.api_key ?? Object.values(values)[0];
      if (typeof primary !== "string" || primary.length === 0) {
        return { ...extracted, slot: null, sealed: false };
      }
      const handle = stashSecretSlot(args.session_id, args.into_slot, primary);
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
      throw new Error("provision_extract store requires an active Trusty Squire session");
    }
    // Egress allow-list seed: start/auto_widen scope (NOT mid_session task scope)
    // unioned with any agent-declared egress_hosts (the API host the page shows).
    // The vault unions this with the service-default; an unknown service with no
    // egress_hosts fails closed (empty) by design.
    const observedHosts = [
      ...new Set([
        ...(args.store.egress_hosts ?? []),
        ...observedHostsForSession(args.session_id),
      ]),
    ];
    const values = extracted.credentials;
    const singleValue = values.api_key;
    const storeInput =
      typeof singleValue === "string" && Object.keys(values).length === 1
        ? { value: singleValue }
        : { fields: values };
    const stored = await api.storeCredential({
      service: args.store.service,
      ...(args.store.label !== undefined ? { label: args.store.label } : {}),
      ...storeInput,
      ...(args.store.env_var_suggestion !== undefined ? { env_var_suggestion: args.store.env_var_suggestion } : {}),
      ...(args.store.type !== undefined ? { type: args.store.type } : { type: "api_key" }),
      ...(args.store.auth_shape !== undefined ? { auth_shape: args.store.auth_shape } : {}),
      ...(observedHosts.length > 0 ? { observed_hosts: observedHosts } : {}),
    });
    return {
      ...extracted,
      stored_credential: {
        reference: stored.reference,
        service: stored.service,
        label: stored.label,
        field_names: stored.field_names,
        allowed_hosts: stored.allowed_hosts,
        updated: stored.updated,
      },
    };
  },
};

const captchaSchema = z.object({ session_id: z.string().min(1) });

export const provisionCaptchaGateTool: Tool<z.infer<typeof captchaSchema>> = {
  name: "provision_captcha_gate",
  description:
    "Detect a captcha and wait for it to clear: returns {found, variant, " +
    "settled}. Invisible Turnstile/reCAPTCHA-v3 usually clears from the humanized " +
    "driving alone; for a visible checkbox, click it with provision_act first, " +
    "then call this to wait for the token. settled=false means a challenge is " +
    "still up (surface captcha_blocked to the user).",
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
});

export const provisionAwaitVerificationTool: Tool<z.infer<typeof verifySchema>> = {
  name: "provision_await_verification",
  description:
    "Read the user's OWN inbox through their signed-in browser session (no IMAP, " +
    "no mail token) to complete email verification: returns {found, code, link, " +
    "needs_user?}. Pass `sender` (e.g. 'resend.com') to scope the search. On " +
    "found=true, type the code with provision_act or goto the link. On " +
    "found=false a `needs_user` object is returned (wall='verification_code') — " +
    "the code came by SMS/authenticator or hasn't arrived: ASK THE USER for it, " +
    "then type it with provision_act and continue. The session stays live; this " +
    "is a resumable hand-back, not a failure. Scoped search-and-extract — reads " +
    "only the matching recent mail, never the whole inbox.",
  inputSchema: verifySchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: { session_id: { type: "string" }, sender: { type: "string" } },
  },
  async handler(args) {
    return await awaitVerification(
      args.session_id,
      args.sender !== undefined ? { sender: args.sender } : {},
    );
  },
};

const finishSchema = z.object({ session_id: z.string().min(1) });

export const provisionFinishTool: Tool<z.infer<typeof finishSchema>> = {
  name: "provision_finish",
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

export const INTERACTIVE_SIGNUP_TOOLS: Tool[] = [
  provisionStartTool,
  provisionObserveTool,
  provisionActTool,
  provisionCaptchaGateTool,
  provisionAwaitVerificationTool,
  provisionExtractTool,
  provisionFinishTool,
] as Tool[];
