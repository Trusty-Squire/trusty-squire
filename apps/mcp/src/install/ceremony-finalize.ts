// What a claimed install sign-in leaves behind on this machine: the account's
// session file, the broker profile's account binding, each requesting host
// agent's MCP config, and the optional 2Captcha key in the vault.
//
// The broker daemon runs this the moment `/status` delivers the claim, so it
// lands even when the `connect` that asked for the sign-in has long since
// exited. `connect`'s own no-ceremony paths (already connected, settings)
// reuse the same config writer.

import { z } from "zod";
import { openSessionStorage, type SessionData } from "../session.js";
import { AGENTS, writeClaudeCodePermissions, type AgentTarget } from "./agents.js";
import { rebindBrokerProfileAccount } from "./broker-service.js";
import * as ui from "./ui.js";

// Managed skill-registry URL. Advanced setup decides whether this is written
// into the MCP config; the URL itself is product-owned and not user-editable.
const DEFAULT_REGISTRY_URL = "https://registry.trustysquire.ai";

const agentTargets = Object.keys(AGENTS) as [AgentTarget, ...AgentTarget[]];

/** One host agent whose MCP config a claim should (re)write. */
export const agentConfigPlanSchema = z
  .object({
    target: z.enum(agentTargets),
    configPath: z.string().min(1).optional(),
    agentIdentity: z.string().min(1).optional(),
    profileDir: z.string().min(1).optional(),
  })
  .strict();
export type AgentConfigPlan = z.infer<typeof agentConfigPlanSchema>;

export const ceremonyFinalizePlanSchema = z
  .object({
    baseSession: z
      .object({
        api_base_url: z.string().min(1),
        saved_at: z.string().min(1),
        machine_token: z.string().min(1).optional(),
        consent_skillify_telemetry: z.boolean().optional(),
        consent_operator_inbox_otp: z.boolean().optional(),
      })
      .strict(),
    // The non-interactive path lets the wizard's stored choices win; an
    // interactive connect just asked the person, so its answers stand.
    applyServerPrefs: z.boolean(),
    agentConfigs: z.array(agentConfigPlanSchema).min(1),
    twoCaptchaKey: z.string().min(1).optional(),
  })
  .strict();
export type CeremonyFinalizePlan = z.infer<typeof ceremonyFinalizePlanSchema>;

export interface InstallClaim {
  token: string;
  account_id: string;
  preferences?: {
    registry_enabled?: boolean;
    consent_operator_inbox_otp?: boolean;
  };
}

// Overlay the server's stored install_preferences onto the local session. Only
// when `applyServerPrefs` (the non-interactive path): in the interactive flow the
// user just answered these questions, so baseSession is authoritative and applying
// stale server prefs would silently discard a fresh consent choice.
export function applyInstallPreferences(
  baseSession: SessionData,
  preferences: InstallClaim["preferences"] | undefined,
  applyServerPrefs: boolean,
): SessionData {
  if (!applyServerPrefs || preferences === undefined) return baseSession;
  return {
    ...baseSession,
    consent_skillify_telemetry: preferences.registry_enabled === true,
    consent_operator_inbox_otp: preferences.consent_operator_inbox_otp !== false,
  };
}

export function resolveServerLaunch(): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", "@trusty-squire/mcp@latest", "server"] };
}

// Tokens themselves are NOT in the env — the MCP server reads them from the
// account's 0600 JSON session file, which keeps them out of any child-process
// listing or shell history.
export async function writeAgentConfig(
  plan: AgentConfigPlan,
  session: SessionData,
  noRegistry: boolean,
): Promise<void> {
  const agent = AGENTS[plan.target];
  const env: Record<string, string> = {
    TRUSTY_SQUIRE_AGENT_IDENTITY: plan.agentIdentity ?? plan.target,
  };
  if (plan.profileDir !== undefined) env.TRUSTY_SQUIRE_PROFILE_DIR = plan.profileDir;
  // Which account this host agent's server serves. Sessions are stored one per
  // account, so pinning it here is what keeps an ALREADY-RUNNING server on the
  // account it was launched for after someone connects a different one: the old
  // process keeps its launch env, the new config names the new account.
  const boundAccount = session.account_id;
  if (boundAccount !== undefined && boundAccount.length > 0) {
    env.TRUSTY_SQUIRE_ACCOUNT_ID = boundAccount;
  }
  // Registry participation is also the user's consent to contribute successful
  // non-personal signup recipes.
  if (!noRegistry) env.TRUSTY_SQUIRE_REGISTRY_URL = DEFAULT_REGISTRY_URL;
  const launch = resolveServerLaunch();
  await agent.writeConfig({
    command: launch.command,
    args: launch.args,
    env,
    ...(plan.configPath !== undefined ? { configPath: plan.configPath } : {}),
  });
  ui.success(
    `Wrote ${agent.display_name} MCP config at ${ui.code(plan.configPath ?? agent.config_path())}`,
  );
  // Claude Code: also pre-allow the safe credential tools so the agent
  // isn't prompted on every use_credential / list / poll / store call.
  if (plan.target === "claude-code") {
    try {
      const settingsPath = await writeClaudeCodePermissions();
      ui.hint(`  Pre-allowed credential tools in ${ui.code(settingsPath)}`);
    } catch {
      ui.hint("  Couldn't write .claude/settings.json permissions (non-fatal)");
    }
  }
  if (noRegistry) {
    ui.hint(
      "  Skill registry disabled — signups are driven fresh by your agent each time " +
        "(no shared skill replay).",
    );
  }
}

// Store the user-supplied 2Captcha key in the vault (encrypted, never written
// to the MCP config). Best-effort: a failure here must never fail the install —
// the bot just won't have the Tier-3 solver. Returns whether it was stored.
export async function storeTwoCaptchaKey(key: string, session: SessionData): Promise<boolean> {
  if (session.agent_session_token === undefined) {
    ui.warn("Couldn't vault the 2Captcha key — no active session yet. Re-run connect to retry.");
    return false;
  }
  try {
    const res = await fetch(`${session.api_base_url}/v1/vault/credentials`, {
      method: "POST",
      signal: AbortSignal.timeout(3_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.agent_session_token}`,
      },
      body: JSON.stringify({
        service: "2captcha",
        label: "default",
        value: key,
        type: "api_key",
        // 2Captcha authenticates with the key as the `key` query param
        // (in.php/res.php). The bot's runtime use_credential calls place the
        // ${SECRET} explicitly; this records the canonical shape for the vault.
        auth_shape: "query:key",
        observed_hosts: ["2captcha.com", "api.2captcha.com"],
        env_var_suggestion: "TWOCAPTCHA_API_KEY",
      }),
    });
    if (res.ok) {
      ui.success("2Captcha key vaulted — the bot spends it through the injecting proxy.");
      return true;
    }
    ui.warn(`Couldn't vault the 2Captcha key (HTTP ${res.status}). Re-run connect to retry.`);
  } catch (err) {
    ui.warn(`Couldn't vault the 2Captcha key: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/** Write each host agent's config for a session that is already on disk. */
export async function writeCeremonyAgentConfigs(
  configs: readonly AgentConfigPlan[],
  session: SessionData,
): Promise<void> {
  for (const config of configs) {
    await writeAgentConfig(config, session, session.consent_skillify_telemetry !== true);
  }
}

/** Land a delivered claim on this machine. */
export async function finalizeCeremonyClaim(
  plan: CeremonyFinalizePlan,
  claim: InstallClaim,
  profileDir: string,
): Promise<SessionData> {
  const { machine_token, consent_skillify_telemetry, consent_operator_inbox_otp } =
    plan.baseSession;
  const base: SessionData = {
    api_base_url: plan.baseSession.api_base_url,
    saved_at: plan.baseSession.saved_at,
    ...(machine_token !== undefined ? { machine_token } : {}),
    ...(consent_skillify_telemetry !== undefined ? { consent_skillify_telemetry } : {}),
    ...(consent_operator_inbox_otp !== undefined ? { consent_operator_inbox_otp } : {}),
  };
  const session: SessionData = {
    ...applyInstallPreferences(base, claim.preferences, plan.applyServerPrefs),
    api_base_url: plan.baseSession.api_base_url,
    saved_at: new Date().toISOString(),
    agent_session_token: claim.token,
    account_id: claim.account_id,
  };
  // Only the completed claim identifies the account for a connect. A busy
  // broker kept its old profile binding through a deferred provider logout;
  // replace it before new agent calls arrive.
  if (claim.account_id.length > 0) await rebindBrokerProfileAccount(profileDir, claim.account_id);
  const storage = await openSessionStorage();
  await storage.write(session);
  await writeCeremonyAgentConfigs(plan.agentConfigs, session);
  if (plan.twoCaptchaKey !== undefined) await storeTwoCaptchaKey(plan.twoCaptchaKey, session);
  ui.success(`Session saved (${storage.path})`);
  return session;
}
