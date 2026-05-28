// Interactive install picker — the Goose / impeccable.style-flavored
// TUI that walks the user through agent selection, OAuth providers,
// and LLM provider config before the install ceremony fires.
//
// Powered by @clack/prompts (select / multiselect / text / confirm /
// note / intro / outro primitives, with consistent box styling).
// Activated when stdin is a TTY and the user didn't pass enough flags
// to imply scripted install. CI / piped input falls through to the
// flag-driven non-interactive path in cli.ts.

import {
  intro,
  outro,
  select,
  multiselect,
  confirm,
  text,
  note,
  isCancel,
  cancel,
} from "@clack/prompts";
import chalk from "chalk";

import { detectInstalledAgents, AGENTS, type AgentTarget } from "./agents.js";

// What the picker resolves to. The caller spreads this into its Argv
// + threads the LLM bits into writeAgentConfig.
export interface InteractiveConfig {
  target: AgentTarget;
  // Providers the user wants connected. Empty means "skip OAuth entirely"
  // — they're declining auto-OAuth and will sign up to each service
  // manually. Rare but legal.
  oauthProviders: ("google" | "github")[];
  // Which LLM call path the universal bot should use. Maps to
  // UNIVERSAL_BOT_LLM_TIER + optional BYOK key in the written MCP config.
  llmChoice: LlmChoice;
  byokKey?: string;
  // Optional residential proxy URL (UNIVERSAL_BOT_PROXY_URL).
  proxyUrl?: string;
  // Whether to wire TRUSTY_SQUIRE_REGISTRY_URL (default yes — the
  // closed-loop router needs it; only off for "I want pure universal-bot
  // mode" power users).
  registryEnabled: boolean;
  registryUrl?: string;
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

async function pickOAuthProviders(
  alreadyConnected: ReadonlySet<"google" | "github">,
): Promise<("google" | "github")[]> {
  // If the bot's Chrome already has cookies for both providers, the
  // picker step is pure friction — skip it and report both as
  // "wanted" so downstream prompts (maybeOfferSecondaryProvider) see
  // a satisfied state and don't ask either.
  if (alreadyConnected.has("google") && alreadyConnected.has("github")) {
    note(
      `${chalk.green("✓")} Google and GitHub already connected — skipping OAuth step.`,
      "OAuth providers",
    );
    return ["google", "github"];
  }

  // Default-select only the providers NOT yet connected. The user can
  // tick a connected one to mean "reconnect" (force a fresh cookie),
  // but the typical-case default is "just fill in what's missing."
  const initialValues: ("google" | "github")[] = [];
  if (!alreadyConnected.has("google")) initialValues.push("google");
  if (!alreadyConnected.has("github")) initialValues.push("github");

  const baseHint = {
    google: "Resend, IPInfo, Postmark, most SaaS",
    github: "Railway, Vercel, Cloudflare, dev tools",
  } as const;

  function hintFor(p: "google" | "github"): string {
    return alreadyConnected.has(p)
      ? `already logged in ✓ — tick to reconnect`
      : baseHint[p];
  }

  const value = bailIfCancelled(
    await multiselect<"google" | "github">({
      message: "Connect OAuth providers (most services accept one of these)",
      initialValues,
      options: [
        { value: "google", label: "Google", hint: hintFor("google") },
        { value: "github", label: "GitHub", hint: hintFor("github") },
      ],
      required: false,
    }),
  );
  // Merge picker selections with already-connected — a connected
  // provider the user didn't tick is still "wanted" (they just don't
  // need to redo it). Downstream logic should treat both sets as
  // available providers.
  const merged = new Set<"google" | "github">([...alreadyConnected, ...value]);
  return [...merged];
}

async function pickLlmConfig(): Promise<{ choice: LlmChoice; byokKey?: string }> {
  const choice = bailIfCancelled(
    await select<LlmChoice>({
      message: "How should the bot pay for LLM calls? (Claude vision powers form-fill on every signup)",
      initialValue: "managed_free",
      options: [
        {
          value: "managed_free",
          label: "Free tier",
          hint: "We cover the first ~10 signups, then ask you to upgrade",
        },
        {
          value: "byok_openrouter",
          label: "OpenRouter",
          hint: "BYOK — use your own OpenRouter key",
        },
        {
          value: "byok_anthropic",
          label: "Anthropic",
          hint: "BYOK — use your own Anthropic key (direct Claude API)",
        },
        {
          value: "byok_openai",
          label: "OpenAI",
          hint: "BYOK — use your own OpenAI key (GPT-4 vision)",
        },
        {
          value: "skip",
          label: "Skip — I'll configure LLM env vars manually",
          hint: "Advanced",
        },
      ],
    }),
  );
  if (choice === "managed_free" || choice === "skip") return { choice };

  // BYOK chosen → ask for the key. clack's text() shows the input
  // inline; we don't echo "***" because that flickers more than it
  // protects, and the key is going to disk in the MCP config anyway.
  const providerLabel =
    choice === "byok_openrouter"
      ? "OpenRouter"
      : choice === "byok_anthropic"
        ? "Anthropic"
        : "OpenAI";
  const key = bailIfCancelled(
    await text({
      message: `Paste your ${providerLabel} API key`,
      placeholder: choice === "byok_anthropic" ? "sk-ant-…" : "sk-…",
      validate: (v) => {
        if (v === undefined || v.length < 8) return "That key looks too short.";
        return undefined;
      },
    }),
  );
  return { choice, byokKey: (key ?? "").trim() };
}

async function pickAdvancedOptions(): Promise<{
  proxyUrl?: string;
  registryEnabled: boolean;
  registryUrl?: string;
}> {
  const wantAdvanced = bailIfCancelled(
    await confirm({
      message: "Configure advanced options? (proxy, skill registry)",
      initialValue: false,
    }),
  );
  if (!wantAdvanced) {
    return { registryEnabled: true };
  }

  // Residential proxy. Most users skip this — datacenter egress is
  // re-routed through our proxy automatically when configured; only
  // power users running on a misclassified residential network ever
  // touch this.
  const wantProxy = bailIfCancelled(
    await confirm({
      message: "Route the bot through a residential proxy?",
      initialValue: false,
    }),
  );
  let proxyUrl: string | undefined;
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

  // Skill registry. Default on (Tier-2 router); off bypasses it
  // entirely (every signup goes through the universal bot).
  const registryEnabled = bailIfCancelled(
    await confirm({
      message: "Enable the skill registry router? (Recommended — reuses cached recipes for ~30s signups)",
      initialValue: true,
    }),
  );
  let registryUrl: string | undefined;
  if (registryEnabled) {
    const wantCustomRegistry = bailIfCancelled(
      await confirm({
        message: "Use a custom registry URL? (default: production)",
        initialValue: false,
      }),
    );
    if (wantCustomRegistry) {
      const url = bailIfCancelled(
        await text({
          message: "Registry base URL",
          placeholder: "https://registry.trustysquire.ai",
          validate: (v) => {
            if (v === undefined || !/^https?:\/\//.test(v))
              return "Must be an http:// or https:// URL.";
            return undefined;
          },
        }),
      );
      registryUrl = (url ?? "").trim();
    }
  }

  return {
    registryEnabled,
    ...(proxyUrl !== undefined ? { proxyUrl } : {}),
    ...(registryUrl !== undefined ? { registryUrl } : {}),
  };
}

function summarize(config: InteractiveConfig): void {
  const lines: string[] = [];
  const agentLabel = AGENTS[config.target].display_name;
  lines.push(`${chalk.dim("Agent:        ")}${chalk.bold(agentLabel)}`);
  const providers =
    config.oauthProviders.length > 0
      ? config.oauthProviders.map((p) => (p === "google" ? "Google" : "GitHub")).join(" + ")
      : chalk.dim("(none — manual signup only)");
  lines.push(`${chalk.dim("OAuth:        ")}${providers}`);
  lines.push(`${chalk.dim("LLM:          ")}${llmChoiceLabel(config.llmChoice)}`);
  if (config.proxyUrl !== undefined) {
    lines.push(`${chalk.dim("Proxy:        ")}${config.proxyUrl}`);
  }
  if (!config.registryEnabled) {
    lines.push(`${chalk.dim("Registry:     ")}${chalk.yellow("disabled")}`);
  } else if (config.registryUrl !== undefined) {
    lines.push(`${chalk.dim("Registry:     ")}${config.registryUrl}`);
  }
  note(lines.join("\n"), "Setup summary");
}

function llmChoiceLabel(c: LlmChoice): string {
  switch (c) {
    case "managed_free":
      return "Free tier (we cover ~10 signups)";
    case "byok_openrouter":
      return "OpenRouter (BYOK)";
    case "byok_anthropic":
      return "Anthropic (BYOK)";
    case "byok_openai":
      return "OpenAI (BYOK)";
    case "skip":
      return chalk.dim("(none configured — you'll set env vars manually)");
  }
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
  initialRegistryUrl?: string;
  registryEnabled: boolean;
  // The bot's Chrome profile's current OAuth state — drives the
  // OAuth picker's "skip if both connected / default-uncheck the
  // already-done ones" UX (the user shouldn't be invited to redo
  // a sign-in they already have).
  alreadyConnected: ReadonlySet<"google" | "github">;
}): Promise<InteractiveConfig> {
  showIntro();

  // Agent: honor --target if passed, else pick.
  const detected = await detectInstalledAgents();
  const target = opts.initialTarget ?? (await pickAgent(detected));

  const oauthProviders = await pickOAuthProviders(opts.alreadyConnected);
  const { choice: llmChoice, byokKey } = await pickLlmConfig();
  // Default-no advanced when --proxy-url isn't passed; if it IS passed,
  // jump straight to confirming the value rather than asking yes/no.
  const advanced =
    opts.initialProxyUrl !== undefined || opts.initialRegistryUrl !== undefined
      ? {
          registryEnabled: opts.registryEnabled,
          ...(opts.initialProxyUrl !== undefined ? { proxyUrl: opts.initialProxyUrl } : {}),
          ...(opts.initialRegistryUrl !== undefined
            ? { registryUrl: opts.initialRegistryUrl }
            : {}),
        }
      : await pickAdvancedOptions();

  const config: InteractiveConfig = {
    target,
    oauthProviders,
    llmChoice,
    ...(byokKey !== undefined ? { byokKey } : {}),
    ...(advanced.proxyUrl !== undefined ? { proxyUrl: advanced.proxyUrl } : {}),
    registryEnabled: advanced.registryEnabled,
    ...(advanced.registryUrl !== undefined ? { registryUrl: advanced.registryUrl } : {}),
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
