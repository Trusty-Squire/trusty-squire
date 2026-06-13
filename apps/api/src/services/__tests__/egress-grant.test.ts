import { describe, expect, it } from "vitest";
import {
  parseAuthShape,
  applyAuthShape,
  hashEgressToken,
  verifyEgressToken,
  mintGrant,
  grantIsLive,
  InMemoryEgressGrantStore,
} from "../egress-grant.js";

describe("parseAuthShape", () => {
  it("defaults to bearer", () => {
    expect(parseAuthShape(undefined)).toEqual({ kind: "bearer" });
    expect(parseAuthShape("")).toEqual({ kind: "bearer" });
    expect(parseAuthShape("bearer")).toEqual({ kind: "bearer" });
    expect(parseAuthShape("nonsense")).toEqual({ kind: "bearer" });
  });
  it("parses header + query shapes", () => {
    expect(parseAuthShape("header:xi-api-key")).toEqual({ kind: "header", name: "xi-api-key" });
    expect(parseAuthShape("query:api_key")).toEqual({ kind: "query", param: "api_key" });
  });
});

describe("applyAuthShape", () => {
  it("bearer injects Authorization and drops any inbound auth (egress token)", () => {
    const r = applyAuthShape({ kind: "bearer" }, "sk-real", { authorization: "Bearer sqr_egress_x", "x-keep": "1" }, {});
    expect(r.headers["authorization"]).toBe("Bearer sk-real");
    expect(r.headers["x-keep"]).toBe("1");
  });
  it("header shape sets the named header (lowercased)", () => {
    const r = applyAuthShape({ kind: "header", name: "xi-api-key" }, "sk-real", { authorization: "Bearer t" }, {});
    expect(r.headers["xi-api-key"]).toBe("sk-real");
    expect(r.headers["authorization"]).toBeUndefined(); // inbound auth stripped
  });
  it("query shape sets the param without touching headers", () => {
    const r = applyAuthShape({ kind: "query", param: "key" }, "sk-real", {}, { model: "x" });
    expect(r.query).toEqual({ model: "x", key: "sk-real" });
  });
  it("never mutates the inputs", () => {
    const headers = { a: "1" };
    const query = { b: "2" };
    applyAuthShape({ kind: "bearer" }, "s", headers, query);
    expect(headers).toEqual({ a: "1" });
    expect(query).toEqual({ b: "2" });
  });
});

describe("token mint/verify", () => {
  it("mints a prefixed token, stores only the hash, and verifies", () => {
    const { grant, token } = mintGrant({
      account_id: "acct1",
      credential_ref: "vault://x",
      rate_limit_per_hour: 100,
      now: "2026-06-13T00:00:00Z",
    });
    expect(token.startsWith("sqr_egress_")).toBe(true);
    expect(grant.token_hash).toBe(hashEgressToken(token));
    expect(grant.token_hash).not.toContain(token); // raw token never in the record
    expect(verifyEgressToken(token, grant.token_hash)).toBe(true);
  });
  it("rejects a wrong/garbage/unprefixed token", () => {
    const { grant } = mintGrant({ account_id: "a", credential_ref: "r", rate_limit_per_hour: 1, now: "t" });
    expect(verifyEgressToken("sqr_egress_wrong", grant.token_hash)).toBe(false);
    expect(verifyEgressToken("not-a-token", grant.token_hash)).toBe(false);
    expect(verifyEgressToken("sqr_egress_x", "zzz")).toBe(false);
  });
});

describe("InMemoryEgressGrantStore", () => {
  it("creates, reads, account-scopes, and revokes (idempotently)", async () => {
    const store = new InMemoryEgressGrantStore();
    const { grant } = mintGrant({ account_id: "acct1", credential_ref: "r", rate_limit_per_hour: 10, now: "t" });
    await store.create(grant);
    expect((await store.getById(grant.id))?.id).toBe(grant.id);
    expect(await store.listByAccount("acct1")).toHaveLength(1);
    expect(await store.listByAccount("other")).toHaveLength(0);
    expect(grantIsLive(grant)).toBe(true);

    // wrong account can't revoke
    expect(await store.revoke(grant.id, "other", "t2")).toBe(false);
    expect(await store.revoke(grant.id, "acct1", "t2")).toBe(true);
    const revoked = await store.getById(grant.id);
    expect(revoked?.revoked_at).toBe("t2");
    expect(grantIsLive(revoked!)).toBe(false);
    expect(await store.revoke(grant.id, "acct1", "t3")).toBe(true); // idempotent
  });
});
