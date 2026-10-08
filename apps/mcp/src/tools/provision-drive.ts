import { ScreenshotClickError } from "../bot/screenshot-click.js";
import { captureSourceSchema, describeCaptureSource } from "../bot/credential-capture.js";
import {
  currentOperatorOperationId,
  markOperatorMutationDispatchAttempted,
  operatorMutationDispatchPhase,
  reconcileOperatorMutationNotDispatched,
  persistOperatorCaptureEvidence,
  throwIfOperatorRequestCancelled,
} from "../bot/request-cancellation.js";
import { runOperateDrive } from "../bot/operate-drive.js";
import { createHash, randomUUID } from "node:crypto";
// Phase 1 — the interactive provisioning tool surface a frontier HOST agent
// drives. The host is the planner; these tools are the browser + the moat.
// Backed by ../bot/provision-session.ts (the session registry over the existing
// BrowserController substrate).
// Browser egress compatibility is documented in docs/operator-tool-surface.md.

import { z } from "zod";
import { getDomain } from "tldts";
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
  awaitVerification,
  generatePassword,
  type ProvisionAction,
  type ExtractResult,
} from "../bot/provision-session.js";
import { isMaskedDisplay } from "../bot/credential-shape.js";
import { openSessionStorage } from "../session.js";
import { servingAccountId } from "../session-guard.js";
import { googleSessionGateForSession, sessionForCall } from "../bot/session/lifecycle.js";
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
  // retained in the session state, action trail, or status.
  proxy: proxySchema.optional(),
  // Operate tasks that act AS the user (drive a gated app on an existing
  // account) set this so start fails closed to a connect hand-back if no live
  // Google session exists — rather than driving into a mid-task login wall.
});

const DOM_OBSERVATION_CONTRACT =
  'With `format:"full"`, `browser-use-dom` returns a tab-indented `dom` tree with text and `[@e:...]` controls. ' +
  "`|SHADOW(open)|` / `|SHADOW(closed)|` mark shadow hosts; `not-targetable=true` refs are display-only. " +
  "`*` marks a new control; `more_above` / `more_below` signal offscreen content. " +
  "On `delta:true`, a present `dom` replaces the prior tree; otherwise keep it and remove refs in `removed`. " +
  "Without delta, reset the view. Refs stay usable on the same document; on stale_ref, observe again. ";

const CONTROL_QUERY_CONTRACT =
  'The default `format:"compact"` response is `browser-use-control-query`: `safe_table` pages controls, including offscreen ones, as `[ref,role,facts?]`. ' +
  "Arbitrary page text is absent from this control map; use full format when text matters. " +
  "Roles b/l/t/s/c/r/tb/m/f mean button/link/textbox/select/checkbox/radio/tab/menuitem/file; other roles are literal. " +
  "`facts` joins an `@label` alias with hints: s=c/u/d/r means checked/unchecked/disabled/required, v=offscreen, a=action, f=field, q=choice-position/total, and x=s/x for same/cross-origin frame (absent x means main frame). `nf=1` is a non-fillable listener; use its separately listed field. " +
  "Query or role filters controls; `m=n/r/t/c` marks name/role/text/context matches. " +
  "`semantic.blocked` and `semantic.blockers` report challenges, validation, dialogs, and error pages regardless of stage. Dialog options include actionable exits; an absent exit ref has target=unavailable. " +
  "Use `overflow.next_cursor` to page with the same query and role; `hint_overflow.next_cursor` pages hints. Document changes invalidate cursors. ";

const ACTION_FORMAT_NOTE =
  'Returns a compact control map; `delta:true` lists changed rows in `safe_table` and departed refs in `removed`. `w=acted` marks the acted row. Use `format:"full"` for the DOM tree. ';

const ACTION_FORMATS = ["compact", "full"] as const;
const actionFormatSchema = z.enum(ACTION_FORMATS);
const actionFormatJson = { type: "string", enum: [...ACTION_FORMATS] };

export const provisionStartTool: Tool<z.infer<typeof startSchema>> = {
  name: "operate_start",
  description:
    "Begin an interactive website task: opens a browser on the " +
    "user's machine at service_url and returns the initial page observation. " +
    CONTROL_QUERY_CONTRACT +
    'Use `format:"full"` only when the page DOM and text are needed. A released card\'s PAN (complete ordinary spellings and prefixes of at least eight digits) and security code are masked; all other emitted content stays verbatim. ' +
    DOM_OBSERVATION_CONTRACT +
    "Use operate_drive for a multi-step goal when a time-bounded handoff is useful; " +
    "operate_click, operate_type, operate_select, operate_navigate, operate_scroll, and operate_login " +
    "complete individual steps. Resume a drive handoff on the same session with answer or added facts. " +
    "inject_card releases a saved card into pan/cvv refs and exposes masked {{pan}}/{{cvv}} per-digit tokens for operate_type placement. " +
    "Call operate_extract when you reach the credentials. Always operate_finish when done. The " +
    "browser has unrestricted egress.",
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
    },
  },
  async handler(args, api, context) {
    const consentInboxRead = await readInboxConsent();
    return await startProvisionSession({
      serviceUrl: args.service_url,
      format: args.format ?? "compact",
      ...(context?.initialObservation === undefined
        ? {}
        : { initialObservation: context.initialObservation }),
      consentInboxRead,
      ...(args.proxy !== undefined ? { proxyUrl: args.proxy } : {}),
      // Thread the api-client so the captcha paths — the provision gate and the
      // operate drive's best-effort auto-solve — can spend a vaulted 2Captcha key.
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
    'Use `format:"full"` only when the page DOM and text are needed. A released card\'s PAN (complete ordinary spellings and prefixes of at least eight digits) and security code are masked; all other emitted content stays verbatim. ' +
    DOM_OBSERVATION_CONTRACT +
    "Supplying query, role, or cursor always selects the compact control-map path, regardless of format.",
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
    "Capture rendered pixels from the viewport (or full_page:true) or one frame via frame_index or frame_url_contains. " +
    "A screenshot costs more context than operate_observe; use it when visual state or a coordinate click matters, " +
    "including a captcha or 3-D Secure ACS frame. During bank approval, short, non-blocking screenshots or observations " +
    "can watch for a change. This read does not interact with the page. Released PAN and security code in injected " +
    "controls and identified displayed copies are covered; if masking fails, capture fails. " +
    "A click_binding authorizes one dispatched operate_click point in original image pixels for 60 seconds; " +
    "navigation, scroll, viewport, or frame changes invalidate it. Without a binding, capture again before a coordinate click.",
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
const captureClickSchema = captureSchema.omit({ write_id: true });
const captureActionSchema = captureClickSchema.extend({
  source: captureSourceSchema.refine(
    (source) => !("clipboard" in source),
    "clipboard capture requires operate_click",
  ),
});
const captureExtractSchema = captureSchema.extend({
  source: captureActionSchema.shape.source,
});
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
        {
          required: ["clipboard"],
          not: {
            anyOf: [
              { required: ["role"] },
              { required: ["name"] },
              { required: ["selector"] },
              { required: ["container"] },
            ],
          },
        },
      ],
      properties: {
        clipboard: { type: "boolean", const: true },
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

const captureJsonFor = (toolName: string) => {
  const { write_id: _writeId, ...actionProperties } = captureJson.properties;
  if (toolName === "operate_click") return { ...captureJson, properties: actionProperties };
  const { clipboard: _clipboard, ...sourceProperties } = captureJson.properties.source.properties;
  return {
    ...captureJson,
    properties: {
      ...(toolName === "operate_extract" ? captureJson.properties : actionProperties),
      source: {
        ...captureJson.properties.source,
        oneOf: captureJson.properties.source.oneOf.slice(0, 2),
        properties: sourceProperties,
      },
    },
  };
};

const CAPTURE_NOTE =
  " Optional capture:{store,source:{role,name?,container?}|{selector,container?}} stores one revealed value after the action and returns metadata, not the value; resolved_source names the element. " +
  "Role and value-free CSS selector sources can cross open shadow roots; a unique secret-shaped textbox can match without an id. " +
  "capture_unresolved returns candidate_count 0 and found roles/names; capture_ambiguous means several matches. " +
  "An unresolved capture does not block unrelated actions. Never paste a secret into a page field to read it.";
const CLICK_CAPTURE_NOTE =
  " On operate_click, source:{clipboard:true} stores only a new clipboard value written by that click; " +
  "an unchanged or empty clipboard stores nothing and reports capture_clipboard_unchanged or capture_clipboard_empty.";
const EXTRACT_CAPTURE_NOTE =
  " Only operate_extract accepts capture.write_id to retry storage after an unresolved capture.";

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
    if (extracted.clipboard_error !== undefined)
      // The click wrote nothing new to the clipboard (or it could not be
      // read). Never store the pre-click clipboard.
      return {
        ...base,
        execution: "completed",
        stored: false,
        storage: "unknown",
        error: extracted.clipboard_error,
        candidate_count: 0,
        retry: "extract_only",
      };
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
      currentProvisionUrl(sessionId),
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
  .describe("Map each current control ref or @label to its visible option text.");

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
  const stored = await persistExtracted(
    args.session_id,
    extracted.url,
    extracted.credentials,
    args.store,
    api,
  );
  return storedExtractResult(extracted, stored);
}

const extractSchema = z.object({
  capture: captureExtractSchema.optional(),
  session_id: z.string().min(1),
  into_slot: z.string().min(1).max(60).optional(),
  secret_label: z.string().min(1).max(60).optional(),
  store: storeShape.optional(),
});

export const provisionExtractTool: Tool<z.infer<typeof extractSchema>> = {
  name: "operate_extract",
  description:
    "Reveal masked keys and extract credentials from the current page: returns " +
    "{credentials, candidate_count}. credentials may include " +
    "`api_key` (or `api_key_truncated` if only a masked display was reachable) " +
    "plus named fields for multi-credential services. Pass `store` to immediately " +
    "save the extracted credential into the Trusty Squire vault with the session's " +
    "observed hosts as allowed_hosts seed; when `store` is used, the response omits " +
    "credential values and returns only vault metadata. " +
    "Call when you have navigated to the keys page. " +
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
  captureUrl: string,
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
  const captureDomain = getDomain(captureUrl, { allowPrivateDomains: true });
  const observedHosts = [
    ...new Set([
      ...(store.egress_hosts ?? []),
      ...observedHostsForSession(sessionId),
      ...(captureDomain === null ? [] : [`*.${captureDomain}`]),
    ]),
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
    stored_credential: stored,
    ...(extracted.masked_remaining !== undefined
      ? { masked_remaining: extracted.masked_remaining }
      : {}),
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
        const stored =
          Object.keys(extracted.credentials).length > 0
            ? await persistExtracted(
                sessionId,
                extracted.url,
                extracted.credentials,
                outcome.store,
                api,
              )
            : null;
        successfulOutcome = stored !== null;
        return {
          kind: "credentials" as const,
          candidate_count: extracted.candidate_count,
          stored_credential: stored,
        };
      }
      successfulOutcome = true;
      return {
        kind: "result" as const,
        summary: (outcome.summary ?? "").slice(0, 4000),
        ...(outcome.data !== undefined ? { data: outcome.data } : {}),
      };
    },
    () => successfulOutcome,
  );
  return { ...prepared, ...finish };
}

const prepareLoginSchema = z.object({
  session_id: z.string().min(1),
  login_slot: z.string().min(1).max(60).optional(),
  password_slot: z.string().min(1).max(60).optional(),
  password_length: z.number().int().min(16).max(64).optional(),
});

async function handlePrepareLogin(args: z.infer<typeof prepareLoginSchema>) {
  const googleGate = await googleSessionGateForSession(args.session_id);
  if (!googleGate.ok) {
    return { session_id: args.session_id, needs_user: googleGate.needs_user };
  }
  const email =
    sessionForCall(args.session_id)?.signupIdentifier ?? getSessionUserEmail(args.session_id);
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
  try {
    return await act(sessionId, action, "compact", outputFormat, compactMapEmitted);
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
  description: "Navigate the session to a URL without session host restrictions.",
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
    capture: captureClickSchema.optional(),
    format: actionFormatSchema.optional(),
  })
  .refine((args) => (args.ref !== undefined) !== (args.screenshot !== undefined), {
    message: "Provide exactly one of ref or screenshot",
  });
export const operateClickTool: Tool<z.infer<typeof clickSchema>> = {
  name: "operate_click",
  description:
    ACTION_FORMAT_NOTE +
    "Prefer a current observation ref or unique @label. If a screenshot-visible control has no usable ref, pass screenshot:{screenshot_id,x,y} from operate_screenshot.click_binding, in original image pixels. Provide exactly one of ref or screenshot. target_unresolved means the label was never issued in this document; stale_ref means its reference or alias expired. stale_screenshot requires a new image. Each image binding permits one DISPATCHED attempt; invalid_screenshot_point (a point outside the image or one that resolves no node) does not consume the binding, so a corrected point may retry the same image. After an uncertain click, observe before deciding any new action. If 3-D Secure bank approval is in progress, do not click, type, navigate, reload, resubmit, or trigger another verification. Only watch with operate_screenshot or operate_observe (short, non-blocking checks) until checkout resolves. Use inject_card for saved-card field entry. A pointer-interception failure may use guarded DOM dispatch internally only when the executor proves no click was dispatched.",
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
    const phaseBeforeClick = operatorMutationDispatchPhase();
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
      reconcileOperatorMutationNotDispatched(phaseBeforeClick);
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
    capture: captureActionSchema.optional(),
    format: actionFormatSchema.optional(),
  })
  .refine((args) => (args.text !== undefined) !== (args.slot !== undefined), {
    message: "Provide exactly one of text or slot",
  });
export const operateTypeTool: Tool<z.infer<typeof typeSchema>> = {
  name: "operate_type",
  description:
    ACTION_FORMAT_NOTE +
    "Fill a control with text, or a session slot returned by operate_login, operate_fill_credential, or operate_extract. Provide exactly one of text or slot. submit presses Enter after a successful fill.",
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
    capture: captureActionSchema.optional(),
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
  capture: captureActionSchema.optional(),
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

const waitSchema = z.object({
  ...sessionShape,
  milliseconds: z.number().int().min(0).max(30_000).default(1_000),
  format: actionFormatSchema.optional(),
});
export const operateWaitTool: Tool<z.infer<typeof waitSchema>> = {
  name: "operate_wait",
  description:
    ACTION_FORMAT_NOTE +
    "Wait briefly for the live page to change, then return a fresh observation. Use this for spinners, late-mounted fields, and pending requests without assigning them a payment stage.",
  inputSchema: waitSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      ...sessionJson,
      milliseconds: { type: "integer", minimum: 0, maximum: 30_000, default: 1_000 },
      format: actionFormatJson,
    },
  },
  async handler(args, _api, context) {
    await new Promise<void>((resolve, reject) => {
      if (context?.signal?.aborted === true) {
        reject(new Error("operation_cancelled"));
        return;
      }
      const timer = setTimeout(resolve, args.milliseconds);
      context?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("operation_cancelled"));
        },
        { once: true },
      );
    });
    return await observe(args.session_id, args.format ?? "compact");
  },
};

// Mailbox verification reads are a session-facing thick call, not a page
// action: the read runs in a dedicated utility tab and the page waiting for
// the emailed value is never navigated.
const readInboxSchema = z.object({
  session_id: z.string().min(1),
  sender: z.string().min(1).max(200).optional(),
  recipient: z.string().min(3).max(320).optional(),
  into_slot: z.string().min(1).max(120).optional(),
  grant_inbox_consent: z.boolean().optional(),
});

export const operateReadInboxTool: Tool<z.infer<typeof readInboxSchema>> = {
  name: "operate_read_inbox",
  description:
    "Read verification mail in a separate tab without changing the live form. Returns {code, link, source_from} or needs_user. " +
    "The default search uses the session recipient and service host; sender and recipient narrow it. " +
    "For an IP or localhost start URL, host scoping is unavailable: check source_from before using the result. " +
    "It checks search and All Mail because Gmail search can lag. A miss reports the query; retry after a few seconds. " +
    "into_slot keeps a found code in a session slot for operate_type; grant_inbox_consent overrides consent for this call. " +
    "If needs_user reports wall:google_session, ask the user to run connect; polling will not clear it.",
  inputSchema: readInboxSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id"],
    properties: {
      session_id: { type: "string" },
      sender: { type: "string" },
      recipient: { type: "string" },
      into_slot: { type: "string" },
      grant_inbox_consent: { type: "boolean" },
    },
  },
  annotations: { readOnlyHint: true },
  async handler(args) {
    return await awaitVerification(args.session_id, {
      ...(args.sender !== undefined ? { sender: args.sender } : {}),
      ...(args.recipient !== undefined ? { recipient: args.recipient } : {}),
      ...(args.into_slot !== undefined ? { intoSlot: args.into_slot } : {}),
      ...(args.grant_inbox_consent !== undefined ? { grantConsent: args.grant_inbox_consent } : {}),
    });
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
    "Finish the task and close its session. outcome='none' closes without a reported outcome; 'credentials' extracts and vault-stores using store; 'result' reports summary or data — the reported outcome is recorded as-is. Successful completion saves eligible login state through the existing teardown.",
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

const driveSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    url: z.string().url().optional(),
    goal: z.string().min(1).max(4000),
    facts: z.record(z.string(), z.string()).optional(),
    max_steps: z.number().int().min(1).max(60).optional(),
    max_seconds: z.number().int().min(1).max(120).optional(),
    answer: z.string().min(1).max(200).optional(),
  })
  .superRefine((value, ctx) => {
    const hasSession = value.session_id !== undefined;
    const hasUrl = value.url !== undefined;
    if (hasSession === hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide exactly one of session_id or url",
      });
    }
  });

export const operateDriveTool: Tool<z.infer<typeof driveSchema>> = {
  name: "operate_drive",
  description:
    "Drive a multi-step signup, checkout, or other website goal and hand back when complete, blocked, or out of budget. " +
    "Pass an open session_id or url to open and drive. goal states the task; facts provides values to type. " +
    "Identity and payment values must come from facts; a search phrase may come from the goal. " +
    "Amount_cents is in the currency's smallest unit: USD $12.34 -> 1234; JPY ¥65,800 -> 65800 (do not multiply by 100); KRW works like JPY. " +
    "The loop can handle Google sign-in, verification mail, captcha, and card release. " +
    "max_steps (default 60) and max_seconds (default 45) bound a call. Resume a budget or other partial handoff on the " +
    "same session with added facts and/or answer from its options. The handoff includes status, current compact observation, " +
    "trajectory, done/remaining, and counters. complete means done; needs_value names a missing field; stuck and low_confidence " +
    "need a decision. invalid_answer, no_progress, budget, evaluate_timeout, pending_approval, and " +
    "card_incomplete are resumable. After a card_incomplete handoff, retry against the same approval_id. " +
    "Always operate_finish when done.",
  inputSchema: driveSchema,
  jsonInputSchema: {
    type: "object",
    required: ["goal"],
    oneOf: [{ required: ["session_id"] }, { required: ["url"] }],
    properties: {
      session_id: { type: "string" },
      url: { type: "string", format: "uri" },
      goal: { type: "string" },
      facts: { type: "object", additionalProperties: { type: "string" } },
      max_steps: { type: "integer", minimum: 1, maximum: 60 },
      max_seconds: { type: "integer", minimum: 1, maximum: 120 },
      answer: { type: "string" },
    },
  },
  async handler(args, api, context) {
    const consentInboxRead = args.url === undefined ? undefined : await readInboxConsent();
    return await runOperateDrive(
      {
        goal: args.goal,
        ...(args.session_id === undefined ? {} : { session_id: args.session_id }),
        ...(args.url === undefined ? {} : { url: args.url }),
        ...(args.facts === undefined ? {} : { facts: args.facts }),
        ...(args.max_steps === undefined ? {} : { max_steps: args.max_steps }),
        ...(args.max_seconds === undefined ? {} : { max_seconds: args.max_seconds }),
        ...(args.answer === undefined ? {} : { answer: args.answer }),
      },
      api,
      {
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
        ...(context?.notifyUser === undefined ? {} : { notifyUser: context.notifyUser }),
        ...(consentInboxRead === undefined ? {} : { consentInboxRead }),
      },
    );
  },
};

// The rest of the vault surface is unchanged and is outside
// the direct observation/action target set.
export const OPERATE_TOOLS: Tool[] = [
  provisionStartTool,
  operateDriveTool,
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
  operateWaitTool,
  operateReadInboxTool,
  operateLoginTool,
  operateFillCredentialTool,
  provisionExtractTool,
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
    Object.assign(properties, { capture: captureJsonFor(tool.name) });
  tool.description +=
    CAPTURE_NOTE +
    (tool.name === "operate_click" ? CLICK_CAPTURE_NOTE : "") +
    (tool.name === "operate_extract" ? EXTRACT_CAPTURE_NOTE : "");
  tool.jsonOutputSchema = captureOutputSchema;
  const handler = tool.handler;
  tool.handler = async (args, api, context) => {
    if (args.capture === undefined) return await handler(args, api, context);
    if (api === null) throw new Error("capture requires an active Trusty Squire session");
    const capture: z.infer<typeof captureSchema> =
      tool.name === "operate_extract"
        ? captureExtractSchema.parse(args.capture)
        : tool.name === "operate_click"
          ? captureClickSchema.parse(args.capture)
          : captureActionSchema.parse(args.capture);
    if (typeof args.session_id !== "string") throw new Error("capture requires a session");
    const recovery = capture.write_id !== undefined;
    if (tool.name !== "operate_extract" && recovery)
      throw new Error("capture.write_id is for extraction-only recovery, not another mutation");
    if ("clipboard" in capture.source && tool.name !== "operate_click")
      throw new Error("capture.source.clipboard is only valid on operate_click");
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
