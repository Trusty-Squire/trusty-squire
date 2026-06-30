// Coverage for POST /v1/captcha-events — focused on the `proxied`
// field. The ledger exists to answer "is the captcha problem wider
// than datacenter IPs?"; `proxied` is what lets a query tell
// "proxy ran and the captcha still fired" apart from "proxy never
// ran". A pre-0.1.8 client omits the field — the route must record
// null (unknown), NOT false (ran direct), so the two cases stay
// distinguishable.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildInMemoryDeps } from "../services/deps.js";
import { InMemoryCaptchaEventStore } from "../services/captcha-events.js";

describe("POST /v1/captcha-events", () => {
  let app: FastifyInstance;
  let captchaStore: InMemoryCaptchaEventStore;

  beforeEach(async () => {
    // Hold a concretely-typed store so the test can read `.events`
    // back — the deps field is typed as the CaptchaEventStore
    // interface, which only exposes record().
    captchaStore = new InMemoryCaptchaEventStore();
    const deps = buildInMemoryDeps({
      sessionSecret: "test-secret-not-used",
    });
    deps.captchaEventStore = captchaStore;
    app = await buildServer({ deps });
  });

  afterEach(async () => {
    await app.close();
  });

  async function issueMachineToken(): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/v1/install" });
    return (res.json() as { machine_token: string }).machine_token;
  }

  async function post(token: string | null, body: unknown) {
    return app.inject({
      method: "POST",
      url: "/v1/captcha-events",
      headers: {
        "content-type": "application/json",
        ...(token !== null ? { "x-machine-token": token } : {}),
      },
      payload: JSON.stringify(body),
    });
  }

  it("records proxied:true when the bot reports a proxied run", async () => {
    const token = await issueMachineToken();
    const res = await post(token, {
      service: "Postmark",
      captcha_kind: "recaptcha",
      blocked: true,
      proxied: true,
    });
    expect(res.statusCode).toBe(202);
    expect(captchaStore.events).toHaveLength(1);
    expect(captchaStore.events[0]?.proxied).toBe(true);
  });

  it("records proxied:false when the bot reports a direct run", async () => {
    const token = await issueMachineToken();
    const res = await post(token, {
      service: "Postmark",
      captcha_kind: "recaptcha",
      blocked: true,
      proxied: false,
    });
    expect(res.statusCode).toBe(202);
    expect(captchaStore.events[0]?.proxied).toBe(false);
  });

  it("records proxied:null when a pre-0.1.8 client omits the field", async () => {
    const token = await issueMachineToken();
    const res = await post(token, {
      service: "Resend",
      captcha_kind: "turnstile",
      blocked: false,
    });
    expect(res.statusCode).toBe(202);
    expect(captchaStore.events[0]?.proxied).toBeNull();
  });

  it("ignores a non-boolean proxied value, recording null", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Mailgun",
      captcha_kind: "recaptcha",
      blocked: false,
      proxied: "yes",
    });
    expect(captchaStore.events[0]?.proxied).toBeNull();
  });

  it("rejects a request with no machine token", async () => {
    const res = await post(null, {
      service: "Postmark",
      captcha_kind: "recaptcha",
      blocked: true,
    });
    expect(res.statusCode).toBe(401);
  });

  // T3.2 spike telemetry — captcha_variant / challenge_rendered /
  // signup_succeeded.
  it("records the spike fields when the bot reports them", async () => {
    const token = await issueMachineToken();
    const res = await post(token, {
      service: "Postmark",
      captcha_kind: "recaptcha",
      blocked: true,
      captcha_variant: "recaptcha_v3",
      challenge_rendered: false,
      signup_succeeded: false,
    });
    expect(res.statusCode).toBe(202);
    const ev = captchaStore.events[0];
    expect(ev?.captcha_variant).toBe("recaptcha_v3");
    expect(ev?.challenge_rendered).toBe(false);
    expect(ev?.signup_succeeded).toBe(false);
  });

  it("records spike fields as null for a pre-0.1.9 client that omits them", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Resend",
      captcha_kind: "turnstile",
      blocked: false,
    });
    const ev = captchaStore.events[0];
    expect(ev?.captcha_variant).toBeNull();
    expect(ev?.challenge_rendered).toBeNull();
    expect(ev?.signup_succeeded).toBeNull();
  });

  it("normalizes an unrecognized captcha_variant to 'unknown'", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Mailgun",
      captcha_kind: "recaptcha",
      blocked: true,
      captcha_variant: "recaptcha_v9_quantum",
    });
    expect(captchaStore.events[0]?.captcha_variant).toBe("unknown");
  });

  // CDP-hardening A/B tag (docs/ARCHITECTURE.md). The route
  // allowlists the two profiles; anything else (or absence) records
  // null so the A/B dimension stays clean.
  it("records stealth_profile=cdp_hardened when the bot reports it", async () => {
    const token = await issueMachineToken();
    const res = await post(token, {
      service: "Cloudflare",
      captcha_kind: "turnstile",
      blocked: true,
      stealth_profile: "cdp_hardened",
    });
    expect(res.statusCode).toBe(202);
    expect(captchaStore.events[0]?.stealth_profile).toBe("cdp_hardened");
  });

  it("records stealth_profile=baseline when the bot reports it", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Cloudflare",
      captcha_kind: "turnstile",
      blocked: true,
      stealth_profile: "baseline",
    });
    expect(captchaStore.events[0]?.stealth_profile).toBe("baseline");
  });

  it("records stealth_profile=null when a pre-CDP-hardening client omits it", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Resend",
      captcha_kind: "turnstile",
      blocked: false,
    });
    expect(captchaStore.events[0]?.stealth_profile).toBeNull();
  });

  it("records stealth_profile=null for an unrecognized value", async () => {
    const token = await issueMachineToken();
    await post(token, {
      service: "Mailgun",
      captcha_kind: "recaptcha",
      blocked: true,
      stealth_profile: "turbo_mode",
    });
    expect(captchaStore.events[0]?.stealth_profile).toBeNull();
  });
});
