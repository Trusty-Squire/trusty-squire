// Universal signup bot — public surface for the bot package.
//
// The autonomous SignupAgent / UniversalSignupBot driver (the 16k-line
// agent.ts monolith) was retired on the retire-universal-bot branch; the
// live provisioning path is the host-driven operate_* tools (see
// provision-session.ts). The autonomous skill-replay ENGINE (replay-skill.ts)
// was excised in the signin-vault PR1 — skills are operator hints now, not
// executed recipes. This barrel re-exports the still-live building blocks.

export { isOAuthProviderId, type OAuthProviderId } from "./oauth-providers.js";
export { BrowserController } from "./browser.js";
export type { CaptchaVariant, CaptchaKind } from "./browser.js";
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
