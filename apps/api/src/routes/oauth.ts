// OAuth login — Google + GitHub.
//
//   GET /v1/auth/oauth/:provider/start     → 302 to the provider.
//   GET /v1/auth/oauth/:provider/callback  → exchange code, resolve
//        the account, mint the ts_session cookie, 302 to the app.
//
// Replaces the Vouchflow passkey signup. Account resolution: an
// existing provider identity wins; otherwise we link to an account
// with the same verified email; otherwise we create one (and attach
// a stub mandate — see auth/stub-mandate.ts).

import { randomBytes } from "node:crypto";
import { type FastifyPluginAsync } from "fastify";
import { issueSession } from "../auth/session.js";
import { setSessionCookie } from "../auth/middleware.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  fetchIdentity,
  isOAuthProvider,
} from "../auth/oauth-providers.js";
import { credsFor, loadOAuthConfig } from "../config/oauth.js";
import type { ApiDeps } from "../services/deps.js";

const STATE_COOKIE = "ts_oauth_state";

// A post-login redirect target. Only same-site relative paths are
// allowed — never an absolute URL — to close off open-redirect abuse.
function safeNext(value: string | undefined): string {
  if (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
  ) {
    return value;
  }
  return "/vault";
}

export const registerOAuthRoute: FastifyPluginAsync<{
  deps: ApiDeps;
  // SIGNUPS_DISABLED global kill switch (checklist #10). When engaged, a
  // callback that resolves to a BRAND-NEW account is refused — but an existing
  // identity or same-email account still signs in (returning users are never
  // blocked). Build-time flag, threaded from server.ts like billingEnabled.
  signupsDisabled: boolean;
}> = async (fastify, opts) => {
  const config = loadOAuthConfig();
  const callbackUri = (provider: string): string =>
    `${config.callbackBaseUrl}/v1/auth/oauth/${provider}/callback`;

  fastify.get<{
    Params: { provider: string };
    Querystring: { next?: string };
  }>(
    "/v1/auth/oauth/:provider/start",
    async (req, reply) => {
      const provider = req.params.provider;
      if (!isOAuthProvider(provider)) {
        reply.code(404).send({ error: "unknown_provider" });
        return;
      }
      const creds = credsFor(config, provider);
      if (creds === null) {
        reply.code(503).send({ error: "provider_not_configured", provider });
        return;
      }
      // CSRF: random state echoed back by the provider, checked at the
      // callback against this short-lived cookie. Provider-prefixed so
      // a state minted for one provider can't satisfy the other.
      const state = randomBytes(16).toString("base64url");
      // The post-login destination rides along in the state cookie so a
      // pairing link survives the OAuth round-trip.
      const next = safeNext(req.query.next);
      reply.setCookie(STATE_COOKIE, `${provider}:${state}:${encodeURIComponent(next)}`, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 600,
      });
      return reply.redirect(
        buildAuthorizeUrl({
          provider,
          clientId: creds.clientId,
          redirectUri: callbackUri(provider),
          state,
        }),
      );
    },
  );

  fastify.get<{
    Params: { provider: string };
    Querystring: { code?: string; state?: string; error?: string };
  }>("/v1/auth/oauth/:provider/callback", async (req, reply) => {
    const provider = req.params.provider;
    if (!isOAuthProvider(provider)) {
      reply.code(404).send({ error: "unknown_provider" });
      return;
    }
    const creds = credsFor(config, provider);
    if (creds === null) {
      reply.code(503).send({ error: "provider_not_configured", provider });
      return;
    }

    // User declined consent at the provider.
    if (typeof req.query.error === "string") {
      return reply.redirect(`${config.appBaseUrl}/login?error=denied`);
    }

    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string") {
      reply.code(400).send({ error: "missing_code_or_state" });
      return;
    }

    // CSRF check, then drop the one-shot cookie regardless of outcome.
    const stateCookie = req.cookies?.[STATE_COOKIE] ?? "";
    reply.clearCookie(STATE_COOKIE, { path: "/" });
    const stateParts = stateCookie.split(":");
    if (
      stateParts.length !== 3 ||
      stateParts[0] !== provider ||
      stateParts[1] !== state
    ) {
      reply.code(400).send({ error: "state_mismatch" });
      return;
    }
    const next = safeNext(decodeURIComponent(stateParts[2] ?? ""));

    let identity;
    try {
      const accessToken = await exchangeCode({
        provider,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        code,
        redirectUri: callbackUri(provider),
      });
      identity = await fetchIdentity(provider, accessToken);
    } catch (err) {
      fastify.log.warn({ err, provider }, "oauth callback failed");
      return reply.redirect(`${config.appBaseUrl}/login?error=oauth_failed`);
    }

    const now = opts.deps.now?.() ?? new Date();

    // Resolve the account. Priority order:
    //   1. Identity already exists → use that account (idempotent re-sign-in).
    //   2. Caller is already signed in (ts_session cookie valid) → bind the
    //      new identity to the current account. This is the install
    //      wizard's "step 2: connect GitHub" path — the user is already
    //      bound to a Google account and we want GitHub to ALSO map to it,
    //      even if the GitHub email differs from the Google email.
    //   3. Same-email account exists → bind the identity to it.
    //   4. New account.
    let account = null;
    const existing = await opts.deps.oauthIdentityStore.findByProvider(
      identity.provider,
      identity.provider_user_id,
    );
    if (existing !== null) {
      account = await opts.deps.accountStore.findAccountById(existing.account_id);
    }

    let isNewAccount = false;
    if (account === null) {
      // Step 2: already-signed-in caller binding a secondary identity.
      // req.auth is populated by the resolveAuth preHandler.
      if (req.auth?.kind === "web") {
        account = await opts.deps.accountStore.findAccountById(req.auth.account_id);
      }
      if (account === null) {
        account = await opts.deps.accountStore.findAccountByEmail(identity.email);
      }
      if (account === null) {
        // SIGNUPS_DISABLED: this is the ONLY place a fresh account is created,
        // and we only reach here after the identity-, web-session-, and
        // same-email lookups above all missed — i.e. a genuinely new signup.
        // Block it (redirect to the login error state, matching how this route
        // signals every other failure) rather than create the account.
        if (opts.signupsDisabled) {
          return reply.redirect(`${config.appBaseUrl}/login?error=signups_disabled`);
        }
        account = await opts.deps.accountStore.createAccount(
          identity.email,
          identity.display_name,
        );
        isNewAccount = true;
      }
      await opts.deps.oauthIdentityStore.create({
        account_id: account.id,
        provider: identity.provider,
        provider_user_id: identity.provider_user_id,
        email: identity.email,
      });
    }

    // Brand-new accounts get the stub mandate so mandate-aware code
    // keeps working without a signing ceremony.
    const { record, jwt } = issueSession({
      account_id: account.id,
      ip: req.ip ?? null,
      user_agent: req.headers["user-agent"] ?? null,
      now,
    });
    await opts.deps.sessionStore.insert(record);
    setSessionCookie(reply, jwt, opts.deps.sessionSecret);

    return reply.redirect(`${config.appBaseUrl}${next}`);
  });
};
