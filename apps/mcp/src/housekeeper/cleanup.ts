// Token cleanup — closed-loop strategy Phase 4.
//
// After the verifier worker successfully extracts a credential from a
// service, this module attempts to delete it so accounts don't
// accumulate verifier-tokens. Cleanup is BEST-EFFORT — a failed
// cleanup is logged but does NOT downgrade the verifier success
// classification. The skill itself worked; the housekeeping didn't.
//
// Two strategies, mirroring the SkillSchema's token_cleanup union:
//   - api_delete:       HTTP DELETE/POST to a templated URL, authed
//                       with the extracted token itself
//   - dashboard_steps:  additional SkillStep[] driven by the same
//                       replay engine that just executed the main
//                       skill — supported by the verifier wrapper's
//                       replay runner (see loop.ts)
//
// Skills with no `token_cleanup` field (or strategy="none") skip
// cleanup entirely. Operators accept the accumulating-tokens cost
// for those services.

import type { Skill } from "@trusty-squire/skill-schema";

export type CleanupOutcome =
  | { kind: "skipped"; reason: "no_strategy" | "no_credential" }
  | { kind: "ok"; strategy: "api_delete" | "dashboard_steps"; status?: number }
  | { kind: "failed"; strategy: "api_delete" | "dashboard_steps"; reason: string };

export interface RunCleanupInput {
  skill: Skill;
  credential: string;
  // The same context the main replay used. Lets ${TOKEN_ID} /
  // ${ACCOUNT} substitution see the worker's environment.
  templateValues?: Record<string, string>;
  // Override globalThis.fetch (tests).
  fetchFn?: typeof globalThis.fetch;
  // Caller drives dashboard_steps replay externally because Playwright
  // setup lives outside this module. When the strategy is
  // dashboard_steps and this fn isn't provided, returns 'skipped' with
  // no_strategy (the caller is responsible for plugging in their own
  // browser-driven cleanup runner).
  runDashboardCleanup?: (steps: Skill["steps"]) => Promise<CleanupOutcome>;
}

export async function runCleanup(input: RunCleanupInput): Promise<CleanupOutcome> {
  const cleanup = input.skill.token_cleanup;
  if (cleanup === undefined || cleanup.strategy === "none") {
    return { kind: "skipped", reason: "no_strategy" };
  }
  if (input.credential.length === 0) {
    return { kind: "skipped", reason: "no_credential" };
  }

  if (cleanup.strategy === "api_delete") {
    const url = substitute(cleanup.url_template, input.templateValues ?? {});
    // Short-circuit on unsubstituted template vars rather than firing
    // a DELETE at a URL containing `MISSING_TOKEN_ID`. The substitute
    // helper marks them with the MISSING_ prefix; surfacing this as a
    // failed outcome is more useful than silently 404ing into the
    // best-effort log.
    if (/\bMISSING_[A-Z_][A-Z0-9_]*\b/.test(url)) {
      return {
        kind: "failed",
        strategy: "api_delete",
        reason: `missing_template_var: url substitution left a MISSING_ marker (${url})`,
      };
    }
    return await runApiDelete({
      url,
      method: cleanup.method,
      authScheme: cleanup.auth_scheme,
      credential: input.credential,
      fetchFn: input.fetchFn ?? globalThis.fetch,
    });
  }
  if (cleanup.strategy === "dashboard_steps") {
    if (input.runDashboardCleanup === undefined) {
      return { kind: "skipped", reason: "no_strategy" };
    }
    try {
      return await input.runDashboardCleanup(cleanup.steps);
    } catch (err) {
      return {
        kind: "failed",
        strategy: "dashboard_steps",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // Exhaustiveness guard — TypeScript should already make this
  // unreachable; the runtime check protects against schema drift.
  return { kind: "skipped", reason: "no_strategy" };
}

async function runApiDelete(args: {
  url: string;
  method: "DELETE" | "POST" | "PUT";
  authScheme: "bearer_self" | "api_key_header";
  credential: string;
  fetchFn: typeof globalThis.fetch;
}): Promise<CleanupOutcome> {
  const headers: Record<string, string> = {};
  if (args.authScheme === "bearer_self") {
    headers["authorization"] = `Bearer ${args.credential}`;
  } else {
    headers["x-api-key"] = args.credential;
  }
  try {
    const res = await args.fetchFn(args.url, {
      method: args.method,
      headers,
    });
    if (res.ok || res.status === 204 || res.status === 404) {
      // 404 = already gone, also a success outcome.
      return { kind: "ok", strategy: "api_delete", status: res.status };
    }
    const body = await res.text().catch(() => "");
    return {
      kind: "failed",
      strategy: "api_delete",
      reason: `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    };
  } catch (err) {
    return {
      kind: "failed",
      strategy: "api_delete",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// Replace ${KEY} / ${KEY:default} in the URL template. Unknown keys
// without a default get a clear marker rather than being left
// literal, so cleanup misfires loud rather than silently hitting the
// wrong URL.
function substitute(template: string, values: Record<string, string>): string {
  return template.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::([^}]*))?\}/g, (_, key, dflt) => {
    const provided = values[key];
    if (provided !== undefined && provided.length > 0) return provided;
    if (dflt !== undefined) return dflt;
    return `MISSING_${key}`;
  });
}
