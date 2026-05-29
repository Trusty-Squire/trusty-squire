// HTTP client for the API's /v1/inbox/* endpoints.
//
// Implements the subset of InboxService the SignupAgent uses so the bot can
// be wired against a real inbox (SES → API) instead of in-memory stores.
// We deliberately don't import the full InboxService class — keeps the
// universal-bot package's deps light and avoids importing Prisma/etc.

export interface RemoteEmailMatcher {
  subject?: RegExp;
  from?: RegExp;
  body_contains?: string;
}

export interface RemoteWaitForEmailInput {
  alias: string;
  matcher: RemoteEmailMatcher;
  timeout_seconds: number;
}

export interface RemoteReceivedEmail {
  id: string;
  alias: string;
  from_address: string;
  subject: string;
  body_text: string | null;
  body_html: string | null;
  parsed_links: string[];
  parsed_codes: string[];
  received_at: string;
}

export interface InboxClientOpts {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  // 0.8.3-rc.1 — when set, the client switches to Workspace IMAP
  // mode. Aliases are generated client-side on this domain (the
  // operator's Workspace catch-all routes them all to a single
  // mailbox), and waitForEmail polls the API's
  // /v1/inbox/poll-workspace-mail endpoint instead of the Resend-
  // backed long-poll. Set via env BOT_INBOX_DOMAIN, or pass
  // explicitly for tests.
  workspaceDomain?: string;
}

// Workspace-domain detection. We treat any host ending in
// `trustysquire.ai` as Workspace by default — the operator's catch-
// all sits there. An explicit `workspaceDomain` option overrides.
function pickWorkspaceDomain(explicit?: string): string | null {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env.BOT_INBOX_DOMAIN;
  if (env !== undefined && env.length > 0) return env;
  return null;
}

function randomLocalPart(): string {
  // Six bytes → 12 hex chars. Enough entropy that two parallel
  // signups never collide; short enough that services with strict
  // local-part length limits don't reject.
  const bytes = new Uint8Array(6);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues !== undefined) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class InboxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceDomain: string | null;

  constructor(opts: InboxClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
    this.workspaceDomain = pickWorkspaceDomain(opts.workspaceDomain);
  }

  async createAlias(input: { account_id: string; service: string; run_id: string; ttl_seconds?: number }): Promise<string> {
    // Workspace path: no DB registration, no quota check. The
    // operator's catch-all delivers any `<random>@<domain>` to one
    // mailbox; the API's poll-workspace-mail endpoint finds the
    // message by its TO header.
    if (this.workspaceDomain !== null) {
      // Include the service slug so an inbox glance disambiguates
      // mail from concurrent signups, plus a per-run random suffix.
      const slug = (input.service ?? "svc")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 18);
      return `${slug}-${randomLocalPart()}@${this.workspaceDomain}`;
    }

    const resp = await this.fetchImpl(`${this.baseUrl}/v1/inbox/aliases`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      throw new Error(`createAlias failed (${resp.status}): ${await resp.text()}`);
    }
    const body = (await resp.json()) as { alias: string };
    return body.alias;
  }

  // Single-shot wait. Server long-polls up to timeout_seconds (max 120).
  // For longer waits the agent should loop.
  async waitForEmail(input: RemoteWaitForEmailInput): Promise<RemoteReceivedEmail> {
    // Workspace path: poll the IMAP-backed endpoint until either an
    // email arrives or our local deadline elapses. Each poll covers
    // up to ~90s of inbox; we loop with a small delay between polls.
    if (this.workspaceDomain !== null && input.alias.endsWith(`@${this.workspaceDomain}`)) {
      return await this.waitForWorkspaceEmail(input);
    }
    const params = new URLSearchParams();
    params.set("timeout_seconds", String(Math.min(input.timeout_seconds, 120)));
    if (input.matcher.subject !== undefined) {
      params.set("subject_pattern", input.matcher.subject.source);
    }
    if (input.matcher.from !== undefined) {
      params.set("from_pattern", input.matcher.from.source);
    }
    if (input.matcher.body_contains !== undefined) {
      params.set("body_contains", input.matcher.body_contains);
    }

    const url = `${this.baseUrl}/v1/inbox/aliases/${encodeURIComponent(input.alias)}/wait?${params.toString()}`;
    const resp = await this.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (resp.status === 408) throw new Error(`Email wait timed out for alias ${input.alias}`);
    if (resp.status === 410) throw new Error(`Alias ${input.alias} is inactive`);
    if (!resp.ok) throw new Error(`waitForEmail failed (${resp.status}): ${await resp.text()}`);
    return (await resp.json()) as RemoteReceivedEmail;
  }

  // Workspace-IMAP-backed long-poll. Calls /v1/inbox/poll-workspace-
  // mail in a loop; the endpoint scans for messages whose TO header
  // matches the alias in the last 90s of the operator's mailbox.
  private async waitForWorkspaceEmail(input: RemoteWaitForEmailInput): Promise<RemoteReceivedEmail> {
    const deadline = Date.now() + Math.max(5, input.timeout_seconds) * 1000;
    const subjectRe = input.matcher.subject;
    const fromRe = input.matcher.from;
    const bodyContains = input.matcher.body_contains;
    while (Date.now() < deadline) {
      const resp = await this.fetchImpl(
        `${this.baseUrl}/v1/inbox/poll-workspace-mail`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            to_address: input.alias,
            since_seconds: 300,
          }),
        },
      );
      if (resp.status === 503) {
        throw new Error("Workspace IMAP not configured on the API");
      }
      if (!resp.ok) {
        throw new Error(
          `poll-workspace-mail failed (${resp.status}): ${await resp.text()}`,
        );
      }
      const data = (await resp.json()) as {
        email: {
          subject: string;
          from_address: string;
          body_text: string;
          body_html: string;
          parsed_links: string[];
          parsed_codes: string[];
          received_at: string;
        } | null;
        reason: string;
      };
      if (data.email !== null) {
        const e = data.email;
        const matchesSubject = subjectRe === undefined || subjectRe.test(e.subject);
        const matchesFrom = fromRe === undefined || fromRe.test(e.from_address);
        const matchesBody =
          bodyContains === undefined ||
          e.body_text.includes(bodyContains) ||
          e.body_html.includes(bodyContains);
        if (matchesSubject && matchesFrom && matchesBody) {
          return {
            id: `workspace:${e.received_at}`,
            alias: input.alias,
            from_address: e.from_address,
            subject: e.subject,
            body_text: e.body_text,
            body_html: e.body_html,
            parsed_links: e.parsed_links,
            parsed_codes: e.parsed_codes,
            received_at: e.received_at,
          };
        }
      }
      // Poll again after a short delay. 5s is short enough that the
      // operator gets a fast reaction once mail lands; long enough
      // not to hammer IMAP.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(5000, remaining)));
    }
    throw new Error(`Email wait timed out for alias ${input.alias}`);
  }

  async revokeAlias(alias: string): Promise<void> {
    // Workspace aliases aren't registered server-side, so revoke is
    // a no-op. The catch-all is what handles delivery; there's no
    // alias-state to invalidate.
    if (this.workspaceDomain !== null && alias.endsWith(`@${this.workspaceDomain}`)) {
      return;
    }
    const resp = await this.fetchImpl(`${this.baseUrl}/v1/inbox/aliases/${encodeURIComponent(alias)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`revokeAlias failed (${resp.status}): ${await resp.text()}`);
    }
  }
}
