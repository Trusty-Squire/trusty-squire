// Unit tests for the shared machine-token-or-admin authorization helper.
// Covers: machine token success, unknown machine token, admin bearer
// success, wrong admin bearer, missing auth, and the admin-bearer-only
// check used by the Postfix webhook.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  authorizeMachineOrAdmin,
  checkAdminBearer,
} from "../authorize-machine-or-admin.js";
import { InMemoryMachineTokenStore } from "../../services/machine-tokens.js";

// Minimal FastifyRequest/Reply stand-ins — the helper only reads
// `headers` and writes via `reply.code().send()`.
function makeReq(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

interface FakeReply {
  statusCode: number | null;
  body: unknown;
  reply: FastifyReply;
}

function makeReply(): FakeReply {
  const state: FakeReply = {
    statusCode: null,
    body: undefined,
    reply: undefined as unknown as FastifyReply,
  };
  const reply = {
    code(c: number) {
      state.statusCode = c;
      return reply;
    },
    send(b: unknown) {
      state.body = b;
      return reply;
    },
  };
  state.reply = reply as unknown as FastifyReply;
  return state;
}

describe("authorizeMachineOrAdmin", () => {
  let store: InMemoryMachineTokenStore;
  let savedKey: string | undefined;

  beforeEach(() => {
    store = new InMemoryMachineTokenStore();
    savedKey = process.env["UNIVERSAL_BOT_API_KEY"];
    process.env["UNIVERSAL_BOT_API_KEY"] = "admin-secret-key";
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env["UNIVERSAL_BOT_API_KEY"];
    else process.env["UNIVERSAL_BOT_API_KEY"] = savedKey;
  });

  it("authorizes a known machine token", async () => {
    const record = await store.issue(new Date());
    const rep = makeReply();
    const principal = await authorizeMachineOrAdmin(
      makeReq({ "x-machine-token": record.token }),
      rep.reply,
      store,
    );
    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("machine");
    if (principal?.kind === "machine") expect(principal.token).toBe(record.token);
  });

  it("rejects an unknown machine token", async () => {
    const rep = makeReply();
    const principal = await authorizeMachineOrAdmin(
      makeReq({ "x-machine-token": "tsm_does-not-exist" }),
      rep.reply,
      store,
    );
    expect(principal).toBeNull();
    expect(rep.statusCode).toBe(401);
  });

  it("authorizes the admin bearer", async () => {
    const rep = makeReply();
    const principal = await authorizeMachineOrAdmin(
      makeReq({ authorization: "Bearer admin-secret-key" }),
      rep.reply,
      store,
    );
    expect(principal?.kind).toBe("admin");
  });

  it("rejects a wrong admin bearer", async () => {
    const rep = makeReply();
    const principal = await authorizeMachineOrAdmin(
      makeReq({ authorization: "Bearer wrong-key" }),
      rep.reply,
      store,
    );
    expect(principal).toBeNull();
    expect(rep.statusCode).toBe(401);
    expect(rep.body).toMatchObject({ error: "invalid_token" });
  });

  it("rejects a request with no auth header", async () => {
    const rep = makeReply();
    const principal = await authorizeMachineOrAdmin(makeReq({}), rep.reply, store);
    expect(principal).toBeNull();
    expect(rep.statusCode).toBe(401);
    expect(rep.body).toMatchObject({ error: "missing_auth" });
  });
});

describe("checkAdminBearer", () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env["UNIVERSAL_BOT_API_KEY"];
  });

  afterEach(() => {
    if (savedKey === undefined) delete process.env["UNIVERSAL_BOT_API_KEY"];
    else process.env["UNIVERSAL_BOT_API_KEY"] = savedKey;
  });

  it("returns ok for the correct bearer", () => {
    process.env["UNIVERSAL_BOT_API_KEY"] = "the-key";
    expect(checkAdminBearer(makeReq({ authorization: "Bearer the-key" }))).toBe("ok");
  });

  it("returns unauthorized for a wrong bearer", () => {
    process.env["UNIVERSAL_BOT_API_KEY"] = "the-key";
    expect(checkAdminBearer(makeReq({ authorization: "Bearer nope" }))).toBe(
      "unauthorized",
    );
  });

  it("returns unconfigured when the env var is missing", () => {
    delete process.env["UNIVERSAL_BOT_API_KEY"];
    expect(checkAdminBearer(makeReq({ authorization: "Bearer anything" }))).toBe(
      "unconfigured",
    );
  });
});
