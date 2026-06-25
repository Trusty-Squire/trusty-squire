// Phase 1 — the interactive provisioning tool surface a frontier HOST agent
// drives. The host is the planner; these tools are the browser + the moat.
// Backed by ../bot/provision-session.ts (the session registry over the existing
// BrowserController substrate). DEFAULT-ON (opt out with PROVISION_DRIVE_TOOLS=0).
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
  extra_allowed_hosts: z.array(z.string().min(1).max(120)).max(10).optional(),
});

export const provisionStartTool: Tool<z.infer<typeof startSchema>> = {
  name: "provision_start",
  description:
    "Begin an interactive provisioning session: opens a scoped browser on the " +
    "user's machine at service_url and returns {session_id, url, text, elements}. " +
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
      extra_allowed_hosts: { type: "array", items: { type: "string" } },
    },
  },
  async handler(args) {
    const hint = await resolveRouteHint(args.service_url);
    return await startProvisionSession({
      serviceUrl: args.service_url,
      ...(args.extra_allowed_hosts !== undefined
        ? { extraAllowedHosts: args.extra_allowed_hosts }
        : {}),
      ...(hint !== undefined ? { hint } : {}),
    });
  },
};

const observeSchema = z.object({ session_id: z.string().min(1) });

export const provisionObserveTool: Tool<z.infer<typeof observeSchema>> = {
  name: "provision_observe",
  description:
    "Re-read the current page of a provisioning session: returns {url, text, " +
    "elements}. Each element has a `ref` (its visible label) you pass back as a " +
    "target, plus `href` for links. Targets are re-resolved live, so refs stay " +
    "valid across re-renders.",
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
  kind: z.enum(["click", "js_click", "type", "goto", "press", "oauth_click", "oauth_settle"]),
  target: z.string().min(1).max(200).optional(),
  text: z.string().max(4096).optional(),
  url: z.string().url().optional(),
  key: z.string().min(1).max(40).optional(),
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
  }
}

export const provisionActTool: Tool<z.infer<typeof actSchema>> = {
  name: "provision_act",
  description:
    "Take one action in a provisioning session, then return the resulting " +
    "observation. kinds: click (target=element ref), type (target + text), " +
    "goto (url — domain-scoped), press (key, e.g. Enter), oauth_click (target — " +
    "use for 'Continue with Google/GitHub' so the popup is adopted), " +
    "oauth_settle (return to the product page after the OAuth handshake).",
  inputSchema: actSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "kind"],
    properties: {
      session_id: { type: "string" },
      kind: {
        type: "string",
        enum: ["click", "js_click", "type", "goto", "press", "oauth_click", "oauth_settle"],
      },
      target: { type: "string" },
      text: { type: "string" },
      url: { type: "string" },
      key: { type: "string" },
    },
  },
  async handler(args) {
    return await act(args.session_id, buildAction(args));
  },
};

const extractSchema = z.object({ session_id: z.string().min(1) });

export const provisionExtractTool: Tool<z.infer<typeof extractSchema>> = {
  name: "provision_extract",
  description:
    "Reveal masked keys and extract credentials from the current page: returns " +
    "{credentials, candidate_count, blocked_reason?}. credentials may include " +
    "`api_key` (or `api_key_truncated` if only a masked display was reachable) " +
    "plus named fields for multi-credential services. If `blocked_reason` is set, " +
    "the page is a login wall / anti-bot interstitial with NO credential present " +
    "(do not treat the empty result as a real key) — drive an interactive login " +
    "or hand back to the user. Call when you have navigated to the keys page.",
  inputSchema: extractSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: { session_id: { type: "string" } },
  },
  async handler(args) {
    return await extractCredentials(args.session_id);
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
    "no mail token) to complete email verification: returns {found, code, link}. " +
    "Pass `sender` (e.g. 'resend.com') to scope the search. Then type the code " +
    "with provision_act, or goto the link. Scoped search-and-extract — it reads " +
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

export const PROVISION_DRIVE_TOOLS: Tool[] = [
  provisionStartTool,
  provisionObserveTool,
  provisionActTool,
  provisionCaptchaGateTool,
  provisionAwaitVerificationTool,
  provisionExtractTool,
  provisionFinishTool,
] as Tool[];

// DEFAULT-ON (2026-06-25 operator decision — "this will be the default soon").
// The interactive provisioning tools ship by default; opt out with
// PROVISION_DRIVE_TOOLS=0/false/off. Domain-scoping, the write-only-vault
// de-fang, and the per-action audit log are in place; the consent-at-install
// prompt is the remaining hardening (tracked in DESIGN-host-planner-perception).
export function provisionDriveToolsEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(process.env.PROVISION_DRIVE_TOOLS ?? "");
}
