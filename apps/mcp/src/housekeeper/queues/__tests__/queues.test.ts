// QueueProvider implementation tests. Three providers + the ad-hoc
// one-shot provider. Each is tested against a stub registry client
// or a fake YAML payload — no real network, no real filesystem.

import { describe, expect, it } from "vitest";
import {
  RegistryVerifierQueue,
  RegistryDiscoverQueue,
  YamlSeedQueue,
  AdHocServiceQueue,
  lookupServiceInYaml,
} from "../index.js";
import type { VerifierQueueItem } from "../../registry-client.js";

function stubClient(opts: {
  queueItems?: VerifierQueueItem[];
  discoveryItems?: Array<{
    service: string;
    distinct_failures: number;
    top_error_kind: string;
    most_recent_at: string;
  }>;
}) {
  return {
    fetchQueue: async (_limit: number) => opts.queueItems ?? [],
    fetchDiscoveryCandidates: async (_opts: Record<string, unknown>) =>
      opts.discoveryItems ?? [],
  };
}

describe("RegistryVerifierQueue", () => {
  it("returns 'replay' tasks shaped from queue items", async () => {
    const item: VerifierQueueItem = {
      skill_id: "01TEST00000000000000000001",
      service: "openrouter",
      version: "v1",
      status: "pending-review",
      verifier_succeeded: 0,
      verifier_failed: 0,
      consecutive_verifier_failures: 0,
      last_verified_at: null,
      next_freshness_due_at: null,
    };
    const queue = new RegistryVerifierQueue(stubClient({ queueItems: [item] }) as never);
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({ kind: "replay", queueItem: item });
  });
});

describe("RegistryDiscoverQueue", () => {
  it("returns 'discover' tasks with meta from candidates", async () => {
    const candidates = [
      {
        service: "newsvc",
        distinct_failures: 5,
        top_error_kind: "no_credentials",
        most_recent_at: "2026-05-26T00:00:00Z",
      },
    ];
    const queue = new RegistryDiscoverQueue(
      stubClient({ discoveryItems: candidates }) as never,
    );
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toEqual({
      kind: "discover",
      service: "newsvc",
      meta: {
        distinct_failures: 5,
        top_error_kind: "no_credentials",
        most_recent_at: "2026-05-26T00:00:00Z",
      },
    });
  });

  it("forwards sinceDays / minDistinct to the client", async () => {
    let received: Record<string, unknown> = {};
    const client = {
      fetchDiscoveryCandidates: async (opts: Record<string, unknown>) => {
        received = opts;
        return [];
      },
    };
    const queue = new RegistryDiscoverQueue(client as never, {
      sinceDays: 7,
      minDistinct: 5,
    });
    await queue.fetch(20);
    expect(received).toEqual({ limit: 20, sinceDays: 7, minDistinct: 5 });
  });
});

describe("YamlSeedQueue", () => {
  it("parses a `services: [...]` shape and returns discover tasks", async () => {
    const yamlText = `services:
  - slug: openrouter
    name: OpenRouter
    status: passing
  - slug: koyeb
    name: Koyeb
    status: skip
    notes: billing wall
  - slug: twilio
    name: Twilio
    status: needs-manual
    notes: phone gate
  - slug: perplexity
    name: Perplexity AI
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    // status:skip + status:needs-manual filtered by default; others
    // included. needs-manual joined the default-filter set in
    // 0.8.2-rc.2 — services explicitly flagged as requiring a human
    // (phone gate, fresh-MX silent drop, OAuth wizard) shouldn't eat
    // bot time on every overnight batch.
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => (t.kind === "discover" ? t.service : ""))).toEqual([
      "openrouter",
      "perplexity",
    ]);
  });

  it("parses a top-level array shape too", async () => {
    const yamlText = `- slug: a
  name: A
- slug: b
  name: B
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(2);
  });

  it("honors a custom excludeStatuses set", async () => {
    const yamlText = `services:
  - { slug: a, status: skip }
  - { slug: b, status: needs-manual }
  - { slug: c, status: passing }
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
      excludeStatuses: new Set(["skip", "needs-manual"]),
    });
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ service: "c" });
  });

  it("caps results to the requested limit", async () => {
    const yamlText = `services:
${Array.from({ length: 30 }, (_, i) => `  - { slug: svc${i} }`).join("\n")}
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(5);
    expect(tasks).toHaveLength(5);
  });

  it("propagates oauth_provider from YAML to the task (bug fix)", async () => {
    // The bot's OAuth-first scan only fires when oauthCandidates is
    // non-empty. resolveOAuthCandidates returns [task.oauthProvider]
    // when set, OR the bot's logged-in-providers cache otherwise. A
    // fresh box has an empty cache, so the YAML hint is the ONLY
    // way to force OAuth on first visit. The seed queue must thread
    // it through; the previous version silently dropped the field.
    const yamlText = `services:
  - { slug: cloudinary, oauth_provider: google }
  - { slug: railway, oauth_provider: github }
  - { slug: ipinfo }
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      kind: "discover",
      service: "cloudinary",
      oauthProvider: "google",
    });
    expect(tasks[1]).toMatchObject({ service: "railway", oauthProvider: "github" });
    // No oauth_provider in YAML → field absent (not undefined-as-value).
    expect("oauthProvider" in tasks[2]!).toBe(false);
  });

  it("ignores invalid oauth_provider values rather than passing them through", async () => {
    const yamlText = `services:
  - { slug: weirdsvc, oauth_provider: discord }
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    expect("oauthProvider" in tasks[0]!).toBe(false);
  });

  it("propagates signup_url from YAML to the task (0.8.1-rc.3)", async () => {
    // Pre-rc.3 the YAML's signup_url was read into YamlServiceEntry
    // but the fetch() map dropped it on the floor. The bot then fell
    // back to guessSignupUrl(slug) which yields https://<slug>.com/
    // signup — wrong for ipinfo.io, console.anthropic.com,
    // console.mistral.ai, etc. Five oauth_required failures in the
    // overnight batch were really wrong-URL navigations to a
    // domain-parked .com that didn't have the OAuth button.
    const yamlText = `services:
  - { slug: ipinfo, signup_url: 'https://ipinfo.io/signup' }
  - { slug: anthropic, signup_url: 'https://console.anthropic.com/login', oauth_provider: google }
  - { slug: nourl }
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]).toMatchObject({
      kind: "discover",
      service: "ipinfo",
      signupUrl: "https://ipinfo.io/signup",
    });
    expect(tasks[1]).toMatchObject({
      service: "anthropic",
      signupUrl: "https://console.anthropic.com/login",
      oauthProvider: "google",
    });
    // No signup_url → field absent (not undefined-as-value, so spread
    // composition stays clean).
    expect("signupUrl" in tasks[2]!).toBe(false);
  });

  it("skips entries with malformed shape (missing slug)", async () => {
    const yamlText = `services:
  - { name: bad }
  - { slug: good }
`;
    const queue = new YamlSeedQueue({
      path: "/fake/path",
      readFn: async () => yamlText,
    });
    const tasks = await queue.fetch(10);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ service: "good" });
  });
});

describe("AdHocServiceQueue", () => {
  it("emits exactly one task on first fetch", async () => {
    const queue = new AdHocServiceQueue("railway");
    expect(await queue.fetch(10)).toEqual([{ kind: "discover", service: "railway" }]);
  });

  it("emits an empty list on subsequent fetches (one-shot)", async () => {
    const queue = new AdHocServiceQueue("railway");
    await queue.fetch(10);
    expect(await queue.fetch(10)).toEqual([]);
  });

  it("propagates the optional signupUrl onto the task (0.8.1-rc.3)", async () => {
    const queue = new AdHocServiceQueue("ipinfo", "google", "https://ipinfo.io/signup");
    const tasks = await queue.fetch(10);
    expect(tasks).toEqual([
      {
        kind: "discover",
        service: "ipinfo",
        oauthProvider: "google",
        signupUrl: "https://ipinfo.io/signup",
      },
    ]);
  });
});

describe("lookupServiceInYaml", () => {
  it("returns the matching entry for a known slug", async () => {
    const yamlText = `services:
  - { slug: ipinfo, signup_url: 'https://ipinfo.io/signup', oauth_provider: google }
  - { slug: resend, signup_url: 'https://resend.com/signup' }
`;
    const entry = await lookupServiceInYaml(
      "/fake/path",
      "ipinfo",
      async () => yamlText,
    );
    expect(entry).toMatchObject({
      slug: "ipinfo",
      signup_url: "https://ipinfo.io/signup",
      oauth_provider: "google",
    });
  });

  it("returns null when the slug isn't in the file", async () => {
    const yamlText = `services:
  - { slug: resend }
`;
    const entry = await lookupServiceInYaml("/fake/path", "ipinfo", async () => yamlText);
    expect(entry).toBeNull();
  });

  it("returns null on a read failure rather than throwing", async () => {
    const entry = await lookupServiceInYaml(
      "/fake/path",
      "ipinfo",
      async () => {
        throw new Error("ENOENT");
      },
    );
    expect(entry).toBeNull();
  });
});
