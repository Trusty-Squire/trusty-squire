// click_link_in_email — wait for a matching email, pick a link out
// of it, then GET the link.
//
// The link's hostname is checked against the adapter's
// network.allowed_domains capability — same gate as http_request.
// Link verification flows almost always point at the SaaS's own
// domain (which is in allowed_domains), so this is rarely surprising
// in practice but catches manifest mistakes.

import type {
  AdapterCapabilities,
  ClickLinkInEmailStepDef,
} from "@trusty-squire/adapter-sdk";
import { EmailTimeoutError, type InboxService } from "@trusty-squire/inbox";
import {
  type BaseStepCtx,
  makeError,
  newStepRecord,
  nowIso,
  parseAsRegexLiteral,
  toInboxMatcher,
} from "./_helpers.js";
import { checkNetworkCapability, classifyHttpStatus } from "./http-request.js";
import type { Run, StepError, StepRecord } from "../types.js";

export interface ClickLinkContext extends BaseStepCtx {
  inbox: InboxService;
  capabilities: AdapterCapabilities;
  fetch?: typeof fetch;
}

export type ClickLinkResult =
  | { kind: "success"; step: StepRecord; new_side_effects: never[] }
  | { kind: "failure"; step: StepRecord; error: StepError };

export async function executeClickLinkInEmail(
  stepDef: ClickLinkInEmailStepDef,
  run: Run,
  ctx: ClickLinkContext,
): Promise<ClickLinkResult> {
  const fetchImpl = ctx.fetch ?? fetch;
  const startedAt = nowIso(ctx);
  const alias = run.context.email_alias;
  const matcher = toInboxMatcher(stepDef.match);
  const linkPattern = parseLinkPattern(stepDef.link_pattern);
  const requestRecord = {
    alias,
    timeout_seconds: stepDef.timeout_seconds,
    link_pattern: stepDef.link_pattern,
    follow_redirects: stepDef.follow_redirects,
  };

  let email;
  try {
    email = await ctx.inbox.waitForEmail({
      alias,
      matcher,
      timeout_seconds: stepDef.timeout_seconds,
    });
  } catch (err) {
    if (err instanceof EmailTimeoutError) {
      return failure(stepDef, ctx, startedAt, requestRecord, null, makeError(
        `EMAIL_TIMEOUT: ${err.message}`,
        {},
        { code: "EMAIL_TIMEOUT" },
      ));
    }
    const message = err instanceof Error ? err.message : String(err);
    return failure(stepDef, ctx, startedAt, requestRecord, null, makeError(message, {}, {
      code: "EMAIL_WAIT_FAILED",
    }));
  }

  const link = await ctx.inbox.parseLink(email, linkPattern ?? undefined);
  if (link === null) {
    return failure(
      stepDef,
      ctx,
      startedAt,
      requestRecord,
      { message_id: email.message_id, links: email.parsed_links },
      makeError("LINK_NOT_FOUND: no link in email matched pattern", {
        causes_tier_escalation: true,
      }, { code: "LINK_NOT_FOUND" }),
    );
  }

  const cap = checkNetworkCapability(link, ctx.capabilities.network.allowed_domains);
  if (!cap.ok) {
    return failure(
      stepDef,
      ctx,
      startedAt,
      requestRecord,
      { message_id: email.message_id, link },
      // Capability violations short-circuit retry/escalate per the
      // chunk-2 state-machine routing.
      makeError(`LINK_DOMAIN_NOT_ALLOWED: ${cap.reason}`, { capability_violation: true }, {
        code: "LINK_DOMAIN_NOT_ALLOWED",
      }),
    );
  }

  let response: Response;
  try {
    response = await fetchImpl(link, {
      method: "GET",
      redirect: stepDef.follow_redirects ? "follow" : "manual",
    });
  } catch (err) {
    return failure(
      stepDef,
      ctx,
      startedAt,
      requestRecord,
      { message_id: email.message_id, link },
      makeError(
        `LINK_NETWORK_ERROR: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true },
        { code: "LINK_NETWORK_ERROR" },
      ),
    );
  }

  if (response.status >= 400) {
    const cls = classifyHttpStatus(response.status);
    return failure(
      stepDef,
      ctx,
      startedAt,
      requestRecord,
      { message_id: email.message_id, link, status: response.status },
      makeError(
        `HTTP_${response.status}: link returned ${response.status}`,
        cls,
        { code: `HTTP_${response.status}` },
      ),
    );
  }

  return {
    kind: "success",
    step: newStepRecord(
      ctx,
      stepDef.id,
      stepDef.type,
      startedAt,
      nowIso(ctx),
      "success",
      requestRecord,
      {
        message_id: email.message_id,
        link,
        status: response.status,
      },
    ),
    new_side_effects: [],
  };
}

function parseLinkPattern(s: string): RegExp | null {
  if (s.length === 0) return null;
  const literal = parseAsRegexLiteral(s);
  if (literal !== null) return literal;
  // Treat as substring — wrap in regex for inbox.parseLink (which
  // accepts string|RegExp; string would be substring-matched but
  // the parseLink signature expects regex when filtering).
  try {
    return new RegExp(s);
  } catch {
    return null;
  }
}

function failure(
  stepDef: ClickLinkInEmailStepDef,
  ctx: ClickLinkContext,
  startedAt: string,
  request: unknown,
  response: unknown,
  error: StepError,
): ClickLinkResult {
  return {
    kind: "failure",
    step: newStepRecord(
      ctx,
      stepDef.id,
      stepDef.type,
      startedAt,
      nowIso(ctx),
      "failure",
      request,
      response,
    ),
    error,
  };
}
