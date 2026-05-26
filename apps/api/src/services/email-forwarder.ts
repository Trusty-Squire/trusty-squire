// Outbound transactional mail via Resend.
//
// Replaces the prior Gmail SMTP (nodemailer) implementation. Gmail
// SMTP delivered fine to third parties but collapsed self-sends
// (GMAIL_USER == account.email) to the Sent folder — the harvester
// case where the operator gmail is also the only paired account.
// Resend sends from a DKIM-verified trustysquire.com address, so
// self-sends and third-party sends are both first-class deliveries.
//
// API: same EmailForwarder class shape as before (sendDirect /
// forward / shouldForward / getForwardAddress) so call sites don't
// change. Construction takes a Resend API key + a sender address;
// without a key the forwarder becomes log-only (dev / test path).
//
// No SDK dep — Resend's send endpoint is a single POST that fits in
// fewer lines than the SDK import would add to the dist tree.

const RESEND_API_BASE = "https://api.resend.com";

export interface EmailAlias {
  from: string; // canonical alias (e.g. "hello@trustysquire.com")
  to: string;   // forward target (e.g. "lunchboxfortwo@gmail.com")
}

export interface EmailForwarderConfig {
  resendApiKey?: string;
  // From address for outbound mail. MUST be on a Resend-verified
  // domain. Defaults to notify@trustysquire.com (DKIM verified at
  // the rc.19 cutover).
  fromAddress?: string;
  // Display name attached to the from address.
  fromName?: string;
}

export class EmailForwarder {
  private aliases: Map<string, string>;
  private resendApiKey: string | null;
  private fromAddress: string;
  private fromName: string;

  constructor(aliases: EmailAlias[], config?: EmailForwarderConfig) {
    this.aliases = new Map(aliases.map((a) => [a.from.toLowerCase(), a.to]));
    this.resendApiKey =
      config?.resendApiKey !== undefined && config.resendApiKey.length > 0
        ? config.resendApiKey
        : null;
    this.fromAddress = config?.fromAddress ?? "notify@trustysquire.com";
    this.fromName = config?.fromName ?? "Trusty Squire";
  }

  getForwardAddress(recipient: string): string | null {
    return this.aliases.get(recipient.toLowerCase()) ?? null;
  }

  shouldForward(recipient: string): boolean {
    return this.aliases.has(recipient.toLowerCase());
  }

  // Send an email to an arbitrary recipient. Used by the notify
  // routes (Google number-match digit email, future transactional
  // surfaces). No alias lookup — the caller picks the destination.
  async sendDirect(params: {
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (this.resendApiKey === null) {
      console.log(
        `[Email Forwarder] sendDirect — RESEND_API_KEY unset, would send to ${params.to}: ${params.subject}`,
      );
      return { success: false, error: "resend_not_configured" };
    }
    return await this.postResendSend({
      from: this.formattedFrom(),
      to: [params.to],
      subject: params.subject,
      text: params.text,
      html: params.html,
    });
  }

  // Forward an inbound email landed at an aliased address to the
  // alias's mapped destination. `from`/`replyTo` preserve the
  // original sender so reply-from-gmail goes back to them.
  async forward(params: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const forwardTo = this.getForwardAddress(params.to);
    if (forwardTo === null) {
      return { success: false, error: "no_alias_match" };
    }
    if (this.resendApiKey === null) {
      console.log(
        `[Email Forwarder] forward — RESEND_API_KEY unset, would forward ${params.from} → ${forwardTo} via alias ${params.to}: ${params.subject}`,
      );
      return { success: false, error: "resend_not_configured" };
    }
    // Use the alias as the display name so the recipient knows which
    // business address received the original message. Reply-to keeps
    // the original sender so replies flow back correctly.
    return await this.postResendSend({
      from: `"${params.to}" <${this.fromAddress}>`,
      to: [forwardTo],
      reply_to: params.from,
      subject: `[${params.to}] ${params.subject}`,
      text: params.text,
      html: params.html,
    });
  }

  private formattedFrom(): string {
    return `"${this.fromName}" <${this.fromAddress}>`;
  }

  private async postResendSend(payload: {
    from: string;
    to: string[];
    subject: string;
    text?: string | undefined;
    html?: string | undefined;
    reply_to?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      // Resend rejects bodies with no text + no html. Provide a
      // single-space fallback rather than letting the request 422.
      const body = {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        ...(payload.text !== undefined ? { text: payload.text } : {}),
        ...(payload.html !== undefined ? { html: payload.html } : {}),
        ...(payload.reply_to !== undefined ? { reply_to: payload.reply_to } : {}),
        ...(payload.text === undefined && payload.html === undefined
          ? { text: " " }
          : {}),
      };
      const res = await fetch(`${RESEND_API_BASE}/emails`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.resendApiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await safeReadDetail(res);
        console.error(
          `[Email Forwarder] Resend send failed: HTTP ${res.status} ${detail}`,
        );
        return { success: false, error: `resend_http_${res.status}` };
      }
      return { success: true };
    } catch (err) {
      console.error("[Email Forwarder] Resend send threw:", err);
      return { success: false, error: "resend_network_error" };
    }
  }
}

async function safeReadDetail(res: Response): Promise<string> {
  try {
    const txt = await res.text();
    return txt.length > 200 ? txt.slice(0, 200) + "…" : txt;
  } catch {
    return "(no body)";
  }
}

// Default aliases for all business domains.
//
// Domain note: trustysquire.com is the rc.19 cutover domain (MX moved
// from SES to Resend). trustysquire.ai aliases stay listed here for
// the legacy forwarder shape but won't see traffic — that domain's
// MX still points at Google Workspaces per CLAUDE.md.
export const DEFAULT_ALIASES: EmailAlias[] = [
  // trustysquire.com
  { from: "dani@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "info@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "press@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "legal@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "partnerships@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "career@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "dev@trustysquire.com", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@trustysquire.com", to: "lunchboxfortwo@gmail.com" },

  // trustysquire.ai — legacy aliases. MX still at Google Workspaces;
  // these don't see traffic via the Resend webhook path.
  { from: "dani@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "info@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },

  // speakeasyapp.xyz
  { from: "dani@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "info@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },

  // vouchflow.dev
  { from: "dani@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "info@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },

  // helmpoint.ai
  { from: "dani@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "info@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
];

