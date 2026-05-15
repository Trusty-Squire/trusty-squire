// Email forwarding service
// Maps business email addresses to personal Gmail and forwards via Gmail SMTP

import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface EmailAlias {
  from: string;  // e.g., "dani@trustysquire.ai"
  to: string;    // e.g., "lunchboxfortwo@gmail.com"
}

export interface EmailForwarderConfig {
  gmailUser?: string;      // Gmail address
  gmailAppPassword?: string; // Gmail app password
}

export class EmailForwarder {
  private aliases: Map<string, string>;
  private transporter: Transporter | null = null;

  constructor(aliases: EmailAlias[], config?: EmailForwarderConfig) {
    this.aliases = new Map(aliases.map(a => [a.from.toLowerCase(), a.to]));
    
    // Set up Gmail SMTP if credentials provided
    if (config?.gmailUser && config?.gmailAppPassword) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: config.gmailUser,
          pass: config.gmailAppPassword,
        },
      });
    }
  }

  // Look up where to forward an email
  getForwardAddress(recipient: string): string | null {
    return this.aliases.get(recipient.toLowerCase()) || null;
  }

  // Check if we should forward this email
  shouldForward(recipient: string): boolean {
    return this.aliases.has(recipient.toLowerCase());
  }

  // Forward an email via Gmail SMTP
  async forward(params: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const forwardTo = this.getForwardAddress(params.to);
    
    if (!forwardTo) {
      return { success: false, error: "no_alias_match" };
    }

    // If no transporter configured, just log
    if (!this.transporter) {
      console.log(`[Email Forwarder] Would forward (no SMTP configured):
        From: ${params.from}
        Original To: ${params.to}
        Forward To: ${forwardTo}
        Subject: ${params.subject}
      `);
      return { success: true };
    }

    // Send via Gmail SMTP
    try {
      const transportOptions = this.transporter.options as any;
      const fromUser = transportOptions.auth?.user || 'noreply@trustysquire.ai';
      
      await this.transporter.sendMail({
        from: `"${params.to}" <${fromUser}>`, // Shows as business email in Gmail
        to: forwardTo,
        replyTo: params.from, // Reply goes to original sender
        subject: `[${params.to}] ${params.subject}`, // Tag with business email
        text: params.text,
        html: params.html,
      });

      console.log(`[Email Forwarder] Successfully forwarded:
        From: ${params.from}
        Original To: ${params.to}
        Forward To: ${forwardTo}
      `);

      return { success: true };
    } catch (err) {
      console.error('[Email Forwarder] Failed to forward:', err);
      return { success: false, error: 'smtp_error' };
    }
  }
}

// Default aliases for all business domains
export const DEFAULT_ALIASES: EmailAlias[] = [
  // trustysquire.ai
  { from: "dani@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "info@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "press@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "legal@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "partnerships@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "career@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "dev@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@trustysquire.ai", to: "lunchboxfortwo@gmail.com" },
  
  // speakeasyapp.xyz
  { from: "dani@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "info@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "press@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "legal@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "partnerships@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "career@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "dev@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@speakeasyapp.xyz", to: "lunchboxfortwo@gmail.com" },
  
  // vouchflow.dev
  { from: "dani@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "info@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "press@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "legal@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "partnerships@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "career@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "dev@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@vouchflow.dev", to: "lunchboxfortwo@gmail.com" },
  
  // helmpoint.ai
  { from: "dani@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "hello@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "info@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "press@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "legal@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "partnerships@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "career@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "dev@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
  { from: "no-reply@helmpoint.ai", to: "lunchboxfortwo@gmail.com" },
];
