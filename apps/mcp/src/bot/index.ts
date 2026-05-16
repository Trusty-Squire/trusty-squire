// Universal signup bot - main entry point
// Orchestrates browser + AI agent to sign up for any service

import { randomBytes } from "crypto";
import { BrowserController } from "./browser.js";
import { SignupAgent, type SignupResult, LLMCallBudgetExceeded } from "./agent.js";
import type { AgentInbox } from "./agent.js";
import type { LLMClient, LLMPair } from "./llm-client.js";

export { type SignupResult, LLMCallBudgetExceeded };
export { InboxClient } from "./inbox-client.js";
export type { AgentInbox };
export { detectAsn, type AsnInfo, type AsnClass } from "./asn.js";
export {
  pickLLMClient,
  pickLLMPair,
  AnthropicDirectClient,
  OpenRouterClient,
  ProxyLLMClient,
  type LLMClient,
  type LLMPair,
  type LLMRequest,
  type LLMResponse,
} from "./llm-client.js";

export interface UniversalSignupRequest {
  service: string;
  signupUrl?: string | undefined;
  email?: string | undefined; // If not provided, generates one
  // Optional inbox for verification — accepts the in-process InboxService
  // or the HTTP InboxClient (both satisfy AgentInbox structurally).
  inbox?: AgentInbox | undefined;
  // Enable human-like browser timing (bezier mouse paths, variable
  // typing delays, post-load dwell). Defaults to true in production
  // because Cloudflare/reCAPTCHA scoring expects it. Disable in tests
  // and debugging runs where you want fast deterministic execution.
  humanize?: boolean | undefined;
  // Optional LLM override. Accepts either:
  //   - LLMClient: a single client; no premium-tier fallback on parse errors
  //   - LLMPair:   primary + optional premium for dual-mode
  // When omitted, the agent picks one from environment (proxy >
  // OpenRouter > Anthropic). Set this when you want explicit control
  // (e.g., from the MCP tool handler that knows the machine token).
  llm?: LLMClient | LLMPair | undefined;
}

export class UniversalSignupBot {
  private generateEmail(): string {
    const random = randomBytes(8).toString("hex");
    return `bot-${random}@trustysquire.ai`;
  }

  private generatePassword(): string {
    // Generate secure random password
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*";
    let password = "";
    const bytes = randomBytes(16);
    for (const byte of bytes) {
      password += chars[byte % chars.length];
    }
    return password;
  }

  async signup(request: UniversalSignupRequest): Promise<SignupResult> {
    // Defaults: humanize=true (production behavior — we want to pass
    // Cloudflare/reCAPTCHA scoring). Tests can pass `humanize: false`
    // to skip the behavior-simulation overhead.
    const browser = new BrowserController({
      humanize: request.humanize ?? true,
    });
    // request.llm is `LLMClient | LLMPair | undefined`; SignupAgent's
    // constructor handles all three shapes.
    const agent = new SignupAgent(browser, request.llm);

    try {
      await browser.start();

      const email = request.email || this.generateEmail();
      // Logs MUST go to stderr. This module is loaded by the MCP server
      // (apps/mcp), whose stdout is a JSON-RPC stdio transport — any stray
      // bytes there corrupt the framing and the host closes the connection
      // with "Transport closed". stderr is the documented log channel for
      // MCP stdio servers.
      console.error(`[UniversalBot] Signing up for ${request.service}`);
      console.error(`[UniversalBot] Using email: ${email}`);

      const result = await agent.signup({
        service: request.service,
        signupUrl: request.signupUrl,
        email,
        generatePassword: () => this.generatePassword(),
        inbox: request.inbox,
      });

      console.error(`[UniversalBot] Result: ${result.success ? "SUCCESS" : "FAILED"}`);
      if (result.success && result.credentials) {
        console.error(`[UniversalBot] Credentials:`, Object.keys(result.credentials));
      }
      if (result.error) {
        console.error(`[UniversalBot] Error: ${result.error}`);
      }

      return result;
    } finally {
      await browser.close();
    }
  }
}

// CLI for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  const serviceName = process.argv[2];
  const signupUrl = process.argv[3];

  if (!serviceName) {
    console.error("Usage: node index.js <service-name> [signup-url]");
    process.exit(1);
  }

  const bot = new UniversalSignupBot();
  const result = await bot.signup({
    service: serviceName,
    signupUrl,
  });

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.success ? 0 : 1);
}
