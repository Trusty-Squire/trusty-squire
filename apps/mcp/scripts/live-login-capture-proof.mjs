#!/usr/bin/env node

// Live-grade login capture proof. This launches real headed Chrome through the
// production runInBotChrome path, walks a scripted non-Google IdP redirect, and
// verifies that the exact authenticated context is the state published to the
// portable snapshot. It uses only synthetic cookies and local HTTP servers.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { runInBotChrome } from "../dist/bot/google-login.js";
import { readSessionState } from "../dist/bot/session-state.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not expose a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const profileDir = await mkdtemp(join(process.cwd(), ".live-login-proof-"));
let relyingPartyOrigin;
let identityProviderOrigin;
let liveCaptureAssertionPassed = false;

const relyingParty = createServer((request, response) => {
  const url = new URL(request.url ?? "/", relyingPartyOrigin);
  if (url.pathname === "/v1/auth/oauth/test/start") {
    const callback = new URL("/v1/auth/oauth/test/callback", relyingPartyOrigin);
    callback.searchParams.set("state", "scripted-proof-state");
    const authorize = new URL("/authorize", identityProviderOrigin);
    authorize.searchParams.set("redirect_uri", callback.toString());
    response.writeHead(302, { location: authorize.toString() }).end();
    return;
  }
  if (
    url.pathname === "/v1/auth/oauth/test/callback" &&
    url.searchParams.get("code") === "scripted-proof-code" &&
    url.searchParams.get("state") === "scripted-proof-state"
  ) {
    response
      .writeHead(302, {
        location: new URL("/vault", relyingPartyOrigin).toString(),
        "set-cookie": "ts_test_session=scripted-rp-session; Path=/; HttpOnly; SameSite=Lax",
      })
      .end();
    return;
  }
  if (url.pathname === "/vault") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Vault</title><main>Authenticated vault</main>");
    return;
  }
  response.writeHead(404).end();
});

const identityProvider = createServer((request, response) => {
  const url = new URL(request.url ?? "/", identityProviderOrigin);
  if (url.pathname !== "/authorize") {
    response.writeHead(404).end();
    return;
  }
  const redirect = new URL(url.searchParams.get("redirect_uri") ?? relyingPartyOrigin);
  redirect.searchParams.set("code", "scripted-proof-code");
  response
    .writeHead(302, {
      location: redirect.toString(),
      "set-cookie": "test_idp_session=scripted-provider-session; Path=/; HttpOnly; SameSite=Lax",
    })
    .end();
});

try {
  const relyingPartyPort = await listen(relyingParty);
  const identityProviderPort = await listen(identityProvider);
  relyingPartyOrigin = `http://127.0.0.1:${relyingPartyPort}`;
  identityProviderOrigin = `http://localhost:${identityProviderPort}`;

  const result = await runInBotChrome({
    profileDir,
    url: `${relyingPartyOrigin}/v1/auth/oauth/test/start`,
    deadline: Date.now() + 30_000,
    bannerLabel: "Running scripted local identity-provider proof.",
    pollUntilDone: async (context) => {
      const providerCookies = await context.cookies(identityProviderOrigin);
      const reachedVault = context.pages().some((page) => {
        try {
          const current = new URL(page.url());
          return current.origin === relyingPartyOrigin && current.pathname === "/vault";
        } catch {
          return false;
        }
      });
      return reachedVault && providerCookies.some((cookie) => cookie.name === "test_idp_session");
    },
    validateCapturedState: (state) => {
      const names = new Set(state.cookies.map((cookie) => cookie.name));
      if (!names.has("test_idp_session") || !names.has("ts_test_session")) {
        throw new Error("authenticated live context cookies were absent before publication");
      }
      liveCaptureAssertionPassed = true;
    },
  });

  const state = await readSessionState(profileDir);
  const raw = JSON.parse(
    await readFile(join(profileDir, "trusty-squire-session-state.json"), "utf8"),
  );
  const cookieNames = new Set((state?.cookies ?? []).map((cookie) => cookie.name));
  const proof = {
    status: result.status,
    snapshotEnvelopeVersion: raw.version ?? null,
    cookieCount: state?.cookies.length ?? 0,
    providerCookieCaptured: cookieNames.has("test_idp_session"),
    relyingPartyCookieCaptured: cookieNames.has("ts_test_session"),
    liveCaptureAssertionPassed,
  };
  console.log(`LOGIN_CAPTURE_PROOF ${JSON.stringify(proof)}`);
  if (
    result.status !== "completed" ||
    proof.snapshotEnvelopeVersion !== 1 ||
    !proof.providerCookieCaptured ||
    !proof.relyingPartyCookieCaptured ||
    !proof.liveCaptureAssertionPassed
  ) {
    process.exitCode = 1;
  }
} finally {
  await Promise.allSettled([close(relyingParty), close(identityProvider)]);
  await rm(profileDir, { recursive: true, force: true });
}
