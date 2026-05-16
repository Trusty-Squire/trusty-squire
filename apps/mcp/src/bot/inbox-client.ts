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
}

export class InboxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: InboxClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async createAlias(input: { account_id: string; service: string; run_id: string; ttl_seconds?: number }): Promise<string> {
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

  async revokeAlias(alias: string): Promise<void> {
    const resp = await this.fetchImpl(`${this.baseUrl}/v1/inbox/aliases/${encodeURIComponent(alias)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!resp.ok && resp.status !== 204) {
      throw new Error(`revokeAlias failed (${resp.status}): ${await resp.text()}`);
    }
  }
}
