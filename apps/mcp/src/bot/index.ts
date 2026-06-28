// Universal signup bot — public surface for the bot package.
//
// The autonomous SignupAgent / UniversalSignupBot driver (the 16k-line
// agent.ts monolith) was retired on the retire-universal-bot branch; the
// live provisioning path is the host-driven provision_* tools (see
// provision-session.ts) plus skill replay (replay-skill.ts). This barrel
// now re-exports only the still-live building blocks those paths share.

export { isOAuthProviderId, type OAuthProviderId } from "./oauth-providers.js";
export { BrowserController } from "./browser.js";
export type { CaptchaVariant, CaptchaKind } from "./browser.js";
export { replaySkill, type ReplayOutcome, type ReplayInput } from "./replay-skill.js";
export { InboxClient } from "./inbox-client.js";
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
