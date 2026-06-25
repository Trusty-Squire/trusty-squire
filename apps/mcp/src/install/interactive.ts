// Interactive install picker — the Goose / impeccable.style-flavored
// TUI that walks the user through agent selection and advanced setup
// before the install ceremony fires.
//
// Powered by @clack/prompts (select / text / confirm /
// note / intro / outro primitives, with consistent box styling).
// Activated when stdin is a TTY and the user didn't pass enough flags
// to imply scripted install. CI / piped input falls through to the
// flag-driven non-interactive path in cli.ts.

import {
  intro,
  outro,
  select,
  confirm,
  text,
  note,
  isCancel,
  cancel,
} from "@clack/prompts";
import chalk from "chalk";

import { detectInstalledAgents, AGENTS, type AgentTarget } from "./agents.js";

// What the picker resolves to. The caller spreads this into its Argv
// + threads the LLM bits into writeAgentConfig. The picker no longer
// asks about OAuth providers — the install wizard rendered in the
// bot's Chrome owns that conversation as of 0.8.2.
export interface InteractiveConfig {
  target: AgentTarget;
  // Legacy shape retained for config-writing compatibility. The signup
  // session agent now drives planning through the Trusty Squire backend by
  // default, so the picker no longer asks users to choose an LLM.
  llmChoice: LlmChoice;
  byokKey?: string;
  // Optional residential proxy URL (UNIVERSAL_BOT_PROXY_URL).
  proxyUrl?: string;
  // Managed registry router. The endpoint is product-owned; advanced setup only
  // controls whether this install uses it.
  registryEnabled: boolean;
  // Privacy-sensitive advanced choices. Undefined means the user did not open
  // advanced settings during this run, so existing session choices should not
  // be overwritten on a config refresh.
  consentSkillifyTelemetry?: boolean;
  consentOperatorInboxOtp?: boolean;
  advancedConfigured: boolean;
}

export type LlmChoice =
  // Default: we pay, ~10 free signups, then upgrade prompt.
  | "managed_free"
  // BYOK paths — written as raw env vars in the MCP config, the
  // server's LLM client routes through them and skips our proxy.
  | "byok_openrouter"
  | "byok_anthropic"
  | "byok_openai"
  // Power user: explicit "don't write any LLM env, I'll set them myself."
  | "skip";

// Heuristic: should we run the picker, or fall through to the existing
// flag-driven flow? Run interactive when:
//   - stdin is a TTY (so clack can actually read keystrokes)
//   - the user didn't pass --skip-browser or any flag that implies
//     they're scripting the install (in which case interactive would
//     just be a hurdle in CI)
//
// Anything that already has a definitive choice baked in (an explicit
// --target=, a --proxy-url=, etc.) still gets to flow through the
// picker — the picker prefills those choices and the user just hits
// enter to accept. The scripted detection is intentionally narrow.
export function shouldRunInteractive(opts: {
  hasTty: boolean;
  skipBrowser: boolean;
  forceRelogin: boolean;
}): boolean {
  if (!opts.hasTty) return false;
  // --skip-browser implies CI / scripted: no picker.
  if (opts.skipBrowser) return false;
  return true;
}

// Cancel-guard. clack returns a Symbol on Ctrl-C; treating it as a
// regular value is a footgun (typescript narrows it to its concrete
// generic type, not Symbol). Wrap each picker call in this and bail
// cleanly if the user cancelled.
function bailIfCancelled<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Install cancelled.");
    process.exit(130); // 128 + SIGINT
  }
  return value as T;
}

// The Goose-style intro panel. Branded title + one-line subtitle.
function showIntro(): void {
  intro(chalk.hex("#cf3a52").bold("Trusty Squire") + chalk.dim(" — setup"));
}

async function pickAgent(detected: Awaited<ReturnType<typeof detectInstalledAgents>>): Promise<AgentTarget> {
  // One detected → fast-path confirm.
  if (detected.length === 1) {
    const only = detected[0]!;
    const yes = bailIfCancelled(
      await confirm({
        message: `Configure for ${chalk.bold(only.display_name)}?`,
        initialValue: true,
      }),
    );
    if (yes) return only.target;
    // User said no — fall through to the full picker so they can choose
    // a different one (or the same one explicitly).
  }
  // Zero detected OR user declined the one-detected fast-path → full
  // picker against the registered agents. Each clack option carries
  // a string-literal `value`, so we cast the array shape — without
  // the cast TS narrows to the union of all per-entry types and the
  // map() output won't fit.
  const value = bailIfCancelled(
    await select({
      message: "Which coding agent should we configure?",
      options: Object.values(AGENTS).map((a) => {
        const hint = detected.some((d) => d.target === a.target)
          ? "installed"
          : "";
        return { value: a.target, label: a.display_name, hint };
      }),
    }),
  );
  return value as AgentTarget;
}

async function pickAdvancedOptionsWithDefaults(opts: {
  initialProxyUrl?: string;
  initialRegistryEnabled?: boolean;
}): Promise<{
  advancedConfigured: boolean;
  proxyUrl?: string;
  registryEnabled: boolean;
  consentSkillifyTelemetry?: boolean;
  consentOperatorInboxOtp?: boolean;
}> {
  const initialRegistryEnabled = opts.initialRegistryEnabled ?? true;
  const wantAdvanced = bailIfCancelled(
    await confirm({
      message: "Configure advanced options? (proxy, registry, OTP)",
      initialValue: opts.initialProxyUrl !== undefined || !initialRegistryEnabled,
    }),
  );
  if (!wantAdvanced) {
    return {
      advancedConfigured: false,
      registryEnabled: initialRegistryEnabled,
      ...(opts.initialProxyUrl !== undefined ? { proxyUrl: opts.initialProxyUrl } : {}),
    };
  }

  // Residential proxy. Most users skip this — datacenter egress is
  // re-routed through our proxy automatically when configured; only
  // power users running on a misclassified residential network ever
  // touch this.
  let proxyUrl = opts.initialProxyUrl;
  if (proxyUrl === undefined) {
    const wantProxy = bailIfCancelled(
      await confirm({
        message: "Route the bot through a residential proxy?",
        initialValue: false,
      }),
    );
    if (wantProxy) {
      const url = bailIfCancelled(
        await text({
          message: "Proxy URL (http://user:pass@host:port or socks5://…)",
          validate: (v) => {
            if (v === undefined || !/^(http|https|socks5):\/\//.test(v)) {
              return "URL must start with http://, https://, or socks5://";
            }
            return undefined;
          },
        }),
      );
      proxyUrl = (url ?? "").trim();
    }
  }

  const registryEnabled = bailIfCancelled(
    await confirm({
      message: "Use the managed skill registry for faster signups?",
      initialValue: initialRegistryEnabled,
    }),
  );

  const consentSkillifyTelemetry = registryEnabled
    ? bailIfCancelled(
        await confirm({
          message:
            "Let successful signup/navigation traces become reusable registry skills? The squire keeps the recipe, not personal details or secrets.",
          initialValue: false,
        }),
      )
    : false;

  const consentOperatorInboxOtp = bailIfCancelled(
    await confirm({
      message:
        "Let the squire poll only matching OTP/verification emails for requested services?",
      initialValue: false,
    }),
  );

  return {
    advancedConfigured: true,
    registryEnabled,
    consentSkillifyTelemetry,
    consentOperatorInboxOtp,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
  };
}

function summarize(config: InteractiveConfig): void {
  const lines: string[] = [];
  const agentLabel = AGENTS[config.target].display_name;
  lines.push(`${chalk.dim("Agent:        ")}${chalk.bold(agentLabel)}`);
  lines.push(`${chalk.dim("Signup:       ")}${chalk.dim("session agent")}`);
  lines.push(`${chalk.dim("OAuth:        ")}${chalk.dim("set up in browser")}`);
  if (config.proxyUrl !== undefined) {
    lines.push(`${chalk.dim("Proxy:        ")}${config.proxyUrl}`);
  }
  lines.push(
    `${chalk.dim("Registry:     ")}${config.registryEnabled ? "managed" : chalk.yellow("disabled")}`,
  );
  if (config.advancedConfigured) {
    lines.push(
      `${chalk.dim("Skillify:     ")}${config.consentSkillifyTelemetry === true ? "allowed" : "off"}`,
    );
    lines.push(
      `${chalk.dim("Email OTP:    ")}${config.consentOperatorInboxOtp === true ? "allowed" : "off"}`,
    );
  }
  note(lines.join("\n"), "Setup summary");
}

// The main entry point. Walks the user through pickers and returns a
// resolved config. Caller (connect() in cli.ts) decides whether to
// run it (via shouldRunInteractive) and then feeds the result into the
// existing install ceremony.
export async function runInteractiveSetup(opts: {
  // Pre-resolved overrides from flags — used to prefill picker defaults
  // so a user who passed `--target=goose --proxy-url=…` still sees the
  // picker but with their choices baked in. Each is optional.
  initialTarget?: AgentTarget;
  initialProxyUrl?: string;
  initialRegistryEnabled?: boolean;
}): Promise<InteractiveConfig> {
  showIntro();

  // Agent: honor --target if passed, else pick.
  const detected = await detectInstalledAgents();
  const target = opts.initialTarget ?? (await pickAgent(detected));

  // Default-no advanced when --proxy-url isn't passed; if it IS passed,
  // carry the value straight through rather than asking yes/no. Signup
  // planning is driven by the session agent, so there is no user-facing LLM
  // picker here.
  const advanced = await pickAdvancedOptionsWithDefaults({
    ...(opts.initialProxyUrl !== undefined ? { initialProxyUrl: opts.initialProxyUrl } : {}),
    ...(opts.initialRegistryEnabled !== undefined
      ? { initialRegistryEnabled: opts.initialRegistryEnabled }
      : {}),
  });

  const llmChoice: LlmChoice = "managed_free";

  const config: InteractiveConfig = {
    target,
    llmChoice,
    ...(advanced.proxyUrl !== undefined ? { proxyUrl: advanced.proxyUrl } : {}),
    registryEnabled: advanced.registryEnabled,
    ...(advanced.consentSkillifyTelemetry !== undefined
      ? { consentSkillifyTelemetry: advanced.consentSkillifyTelemetry }
      : {}),
    ...(advanced.consentOperatorInboxOtp !== undefined
      ? { consentOperatorInboxOtp: advanced.consentOperatorInboxOtp }
      : {}),
    advancedConfigured: advanced.advancedConfigured,
  };

  summarize(config);

  const proceed = bailIfCancelled(
    await confirm({
      message: "Proceed with these settings?",
      initialValue: true,
    }),
  );
  if (!proceed) {
    cancel("Install cancelled.");
    process.exit(0);
  }

  return config;
}

// Public so cli.ts can emit the final celebratory line through clack
// after the install ceremony finishes — keeps the box styling
// consistent.
export function showOutro(message: string): void {
  outro(message);
}
