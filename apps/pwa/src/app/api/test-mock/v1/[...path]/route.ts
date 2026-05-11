// Test-mode API mock. Only mounted in stub mode (and even then only
// returns canned responses for the endpoints the E2E tests exercise).
//
// All routes are intentionally permissive: tests verify the UI flow,
// not the API contract — that contract is already pinned by the apps/api
// test suite. We only need the wire shape to be roughly right so the
// React Query / fetch calls succeed.

import { NextResponse } from "next/server";

interface Ctx {
  params: Promise<{ path: string[] }>;
}

function ok<T extends object>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

async function handle(req: Request, ctx: Ctx): Promise<NextResponse> {
  const { path } = await ctx.params;
  const route = path.join("/");

  if (route === "accounts" && req.method === "POST") {
    return ok(
      {
        account: { id: "acc_test", email: "test@example.com", display_name: "Test" },
        session: { id: "ses_test", absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
      },
      201,
    );
  }
  if (route === "auth/login" && req.method === "POST") {
    return ok({
      account: { id: "acc_test", email: "test@example.com", display_name: "Test" },
      session: { id: "ses_test", absolute_expires_at: new Date(Date.now() + 86_400_000).toISOString() },
    });
  }
  if (route === "auth/logout" && req.method === "POST") {
    return ok({ ok: true });
  }
  if (route === "mandates" && req.method === "POST") {
    return ok({ mandate: { id: "mnd_test", version: 1, expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString() } }, 201);
  }
  if (route === "mandates/active" && req.method === "GET") {
    return ok({ mandate: null });
  }
  if (route === "subscriptions" && req.method === "GET") {
    return ok({
      subscriptions: [
        {
          id: "sub_test",
          service_name: "Resend",
          service_reference: "email-api/resend",
          monthly_cost_cents: 0,
          status: "active" as const,
          started_at: new Date().toISOString(),
        },
      ],
    });
  }
  if (route === "ledger" && req.method === "GET") {
    return ok({
      entries: [
        {
          id: "led_test",
          ts: new Date().toISOString(),
          kind: "run.completed",
          summary: "Provisioned Resend",
          amount_cents: 0,
        },
      ],
    });
  }
  if (route === "usage" && req.method === "GET") {
    return ok({
      window_start: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      window_end: new Date().toISOString(),
      total_spend_cents: 0,
      budget_cents: 50_000,
      by_category: [],
    });
  }
  if (route.startsWith("mcp/pair/") && route.endsWith("/status") && req.method === "GET") {
    return ok({ status: "pending", agent_identity: "claude-code" });
  }
  if (route.startsWith("mcp/pair/") && route.endsWith("/claim") && req.method === "POST") {
    return ok({ ok: true, agent_session_id: "as_test", account_id: "acc_test" });
  }
  return NextResponse.json({ error: "not_found", route }, { status: 404 });
}

export { handle as GET, handle as POST, handle as DELETE, handle as PUT };
