// Queue providers — the housekeeper pulls from one of three sources:
//
//   - RegistryVerifierQueue   — pending-review + freshness-due skills
//                               (autonomous closed-loop validation)
//   - RegistryDiscoveryQueue  — services with ≥3 distinct user failures,
//                               no skill yet (autonomous discovery)
//   - YamlSeedQueue           — curated services.yaml list, with
//                               `status: skip` annotations honored
//                               (the old harvester's curated path)
//
// Plus an AdHocQueue for `--service=<slug>` single-service runs.
//
// Each provider returns a HousekeeperTask: a queue item the run loop
// dispatches via the correct handler (replay-skill for verifier tasks,
// universal-bot-signup for discovery/seed tasks).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  VerifierRegistryClient,
  type VerifierQueueItem,
} from "./registry-client.js";

// The two action kinds the loop dispatches on. A `replay` task carries
// a skill the housekeeper already-fetches the body of (via the
// registry client) — it goes through the existing replaySkill flow.
// A `discover` task carries just a service slug — it goes through the
// universal bot's fresh-signup flow.
export type HousekeeperTask =
  | {
      kind: "replay";
      // Verifier flow needs the full skill record reference; the body
      // is fetched separately so callers can mock cleanly.
      queueItem: VerifierQueueItem;
    }
  | {
      kind: "discover";
      service: string;
      // Optional OAuth provider hint from the curated YAML (or
      // future telemetry sources). Forces the bot's OAuth-first
      // scan to look for THIS provider rather than relying on
      // the bot profile's logged-in-providers cache. Plumbed
      // through to UniversalSignupBot.signup() so the OAuth-first
      // detection actually fires when the YAML declares one.
      oauthProvider?: "google" | "github";
      // Optional canonical signup URL from the curated YAML. Without
      // this the bot calls guessSignupUrl(slug) which defaults to
      // https://<slug>.com/signup — wrong for any service whose
      // public domain isn't `.com` (ipinfo.io, plaid.com vs api.plaid,
      // anthropic.com vs console.anthropic.com). The YAML knows the
      // real URL; pre-0.8.1-rc.3 it was read into YamlServiceEntry
      // but never plumbed to the task. Fix surfaces 5 oauth_required
      // failures that were really wrong-URL navigations.
      signupUrl?: string;
      // Optional metadata for the notifier surfaces (telegram, GH issue).
      // Discovery candidates come with telemetry counts; seed/ad-hoc
      // tasks leave this null.
      meta?: {
        distinct_failures?: number;
        top_error_kind?: string;
        most_recent_at?: string;
      };
    };

export interface QueueProvider {
  // Identifier — flows through to step trail + notifier subject lines.
  readonly name: string;
  // Pull up to `limit` tasks. Implementations may return fewer; an
  // empty array signals "nothing to do this batch."
  fetch(limit: number): Promise<HousekeeperTask[]>;
}

// ── Registry-driven providers ──────────────────────────────────────

export class RegistryVerifierQueue implements QueueProvider {
  readonly name = "verifier";
  constructor(private readonly client: VerifierRegistryClient) {}
  async fetch(limit: number): Promise<HousekeeperTask[]> {
    const items = await this.client.fetchQueue(limit);
    return items.map((queueItem) => ({ kind: "replay" as const, queueItem }));
  }
}

export class RegistryDiscoveryQueue implements QueueProvider {
  readonly name = "discovery";
  constructor(
    private readonly client: VerifierRegistryClient,
    private readonly opts: { sinceDays?: number; minDistinct?: number } = {},
  ) {}
  async fetch(limit: number): Promise<HousekeeperTask[]> {
    const candidates = await this.client.fetchDiscoveryCandidates({
      limit,
      ...(this.opts.sinceDays !== undefined ? { sinceDays: this.opts.sinceDays } : {}),
      ...(this.opts.minDistinct !== undefined ? { minDistinct: this.opts.minDistinct } : {}),
    });
    return candidates.map((c) => ({
      kind: "discover" as const,
      service: c.service,
      meta: {
        distinct_failures: c.distinct_failures,
        top_error_kind: c.top_error_kind,
        most_recent_at: c.most_recent_at,
      },
    }));
  }
}

// ── YAML seed provider (the harvester's curated path) ─────────────

interface YamlServiceEntry {
  slug: string;
  name?: string;
  status?: string;
  signup_url?: string;
  oauth_provider?: string | null;
  notes?: string;
}

interface YamlSeedFile {
  // Tolerate both `services: [...]` and a top-level list, matching
  // the harvester's existing format.
  services?: YamlServiceEntry[];
}

export class YamlSeedQueue implements QueueProvider {
  readonly name = "seed";
  // Filled lazily on first fetch so test fixtures can swap the file
  // path without re-instantiating.
  private cache: YamlServiceEntry[] | null = null;

  constructor(
    private readonly opts: {
      path: string;
      // Filter — anything whose status is in this set is skipped.
      // Default: ["skip"]. Use empty set to disable filtering.
      excludeStatuses?: ReadonlySet<string>;
      // Read function injection for tests.
      readFn?: (path: string) => Promise<string>;
    },
  ) {}

  async fetch(limit: number): Promise<HousekeeperTask[]> {
    if (this.cache === null) {
      this.cache = await this.load();
    }
    return this.cache.slice(0, limit).map((e) => {
      const oauthProvider =
        e.oauth_provider === "google" || e.oauth_provider === "github"
          ? e.oauth_provider
          : undefined;
      return {
        kind: "discover" as const,
        service: e.slug,
        ...(oauthProvider !== undefined ? { oauthProvider } : {}),
        ...(e.signup_url !== undefined && e.signup_url.length > 0
          ? { signupUrl: e.signup_url }
          : {}),
      };
    });
  }

  private async load(): Promise<YamlServiceEntry[]> {
    const reader = this.opts.readFn ?? ((p) => readFile(p, "utf8"));
    const text = await reader(this.opts.path);
    const parsed = parseYaml(text) as YamlSeedFile | YamlServiceEntry[];
    const services = Array.isArray(parsed) ? parsed : (parsed.services ?? []);
    const exclude = this.opts.excludeStatuses ?? new Set(["skip"]);
    return services.filter((e) => {
      if (e === null || typeof e !== "object") return false;
      if (typeof e.slug !== "string" || e.slug.length === 0) return false;
      if (e.status !== undefined && exclude.has(e.status)) return false;
      return true;
    });
  }
}

// ── Ad-hoc single-service provider (--service=<slug>) ─────────────

export class AdHocServiceQueue implements QueueProvider {
  readonly name = "ad-hoc";
  private fired = false;
  constructor(
    private readonly service: string,
    // Optional OAuth hint — same shape the YAML seed queue would emit.
    // Forces the bot's OAuth-first scan to look for THIS provider on
    // the signup page rather than relying on the bot profile's
    // logged-in-providers cache (often empty on a fresh box).
    private readonly oauthProvider?: "google" | "github",
    // Optional canonical signup URL — populated by the CLI when the
    // operator pairs `--service=` with `--from=<yaml>` so single-
    // service ad-hoc runs benefit from the same curated URLs the
    // seed queue uses. Without this the bot falls back to
    // guessSignupUrl(slug) → https://<slug>.com/signup which is
    // wrong for any non-.com service (ipinfo.io etc.).
    private readonly signupUrl?: string,
  ) {}
  async fetch(_limit: number): Promise<HousekeeperTask[]> {
    if (this.fired) return [];
    this.fired = true;
    return [
      {
        kind: "discover",
        service: this.service,
        ...(this.oauthProvider !== undefined
          ? { oauthProvider: this.oauthProvider }
          : {}),
        ...(this.signupUrl !== undefined && this.signupUrl.length > 0
          ? { signupUrl: this.signupUrl }
          : {}),
      },
    ];
  }
}

// Look up one service slug in a YAML seed file. Used by the CLI to
// pre-populate AdHocServiceQueue with the YAML's signup_url +
// oauth_provider so `--service=X` matches the seed-queue behaviour
// when an operator pairs it with `--from=<yaml>`. Returns null when
// the file isn't found, the slug isn't in the file, or the file is
// malformed — the caller falls back to the slug-only AdHocServiceQueue.
export async function lookupServiceInYaml(
  path: string,
  slug: string,
  readFn?: (p: string) => Promise<string>,
): Promise<YamlServiceEntry | null> {
  try {
    const reader = readFn ?? ((p: string) => readFile(p, "utf8"));
    const text = await reader(path);
    const parsed = parseYaml(text) as YamlSeedFile | YamlServiceEntry[];
    const list = Array.isArray(parsed) ? parsed : (parsed.services ?? []);
    return list.find((e) => e?.slug === slug) ?? null;
  } catch {
    return null;
  }
}
