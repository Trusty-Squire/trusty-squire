import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Squire, WebhookVerificationError, verifyWebhook } from "../src/index.js";
import { APPROVAL_WIRE } from "./fixtures.js";

const SECRET = "whsec_test_secret_value";
const NOW_MS = Date.parse("2026-10-27T12:00:00.000Z");
const NOW_S = Math.floor(NOW_MS / 1000);

const EVENT = {
  id: "evt_01JD0000000000000000000001",
  type: "approval.denied",
  created_at: "2026-10-27T12:00:00.000Z",
  approval: { ...APPROVAL_WIRE, status: "denied" },
};
const BODY = JSON.stringify(EVENT);

// The same construction the API uses to sign a delivery.
function sign(body: string, timestamp = NOW_S, secret = SECRET): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

function headers(signature: string, eventId = EVENT.id): Record<string, string> {
  return { "squire-signature": signature, "squire-event-id": eventId, "content-type": "application/json" };
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(WebhookVerificationError);
  return (error as WebhookVerificationError).code;
}

describe("verifyWebhook", () => {
  it("accepts a correctly signed, fresh delivery and returns the decision", async () => {
    const event = await verifyWebhook(BODY, headers(sign(BODY)), SECRET, { now: () => NOW_MS });
    expect(event).toMatchObject({
      id: EVENT.id,
      type: "approval.denied",
      approvalId: APPROVAL_WIRE.id,
      decision: "denied",
      approval: { id: APPROVAL_WIRE.id, status: "denied", approveUrl: APPROVAL_WIRE.approve_url },
    });
  });

  it("accepts Headers objects, array values and byte bodies", async () => {
    const fetchHeaders = new Headers(headers(sign(BODY)));
    await expect(verifyWebhook(BODY, fetchHeaders, SECRET, { now: () => NOW_MS })).resolves.toBeTruthy();
    const nodeHeaders = { "Squire-Signature": [sign(BODY)], "squire-event-id": EVENT.id };
    await expect(
      verifyWebhook(new TextEncoder().encode(BODY), nodeHeaders, SECRET, { now: () => NOW_MS }),
    ).resolves.toBeTruthy();
  });

  it("accepts any matching v1 signature, so a rotated secret can overlap", async () => {
    const other = sign(BODY, NOW_S, "whsec_old").split(",v1=")[1];
    const signature = `${sign(BODY)},v1=${other}`;
    await expect(verifyWebhook(BODY, headers(signature), SECRET, { now: () => NOW_MS })).resolves.toBeTruthy();
  });

  it("rejects a changed body", async () => {
    const forged = BODY.replace('"denied"', '"approved"');
    expect(await code(verifyWebhook(forged, headers(sign(BODY)), SECRET, { now: () => NOW_MS }))).toBe(
      "invalid_signature",
    );
  });

  it("rejects a signature made with another secret", async () => {
    expect(
      await code(verifyWebhook(BODY, headers(sign(BODY, NOW_S, "whsec_attacker")), SECRET, { now: () => NOW_MS })),
    ).toBe("invalid_signature");
  });

  it("rejects a replay outside the tolerance, past or future", async () => {
    const old = sign(BODY, NOW_S - 301);
    expect(await code(verifyWebhook(BODY, headers(old), SECRET, { now: () => NOW_MS }))).toBe(
      "timestamp_out_of_range",
    );
    const future = sign(BODY, NOW_S + 301);
    expect(await code(verifyWebhook(BODY, headers(future), SECRET, { now: () => NOW_MS }))).toBe(
      "timestamp_out_of_range",
    );
    await expect(
      verifyWebhook(BODY, headers(old), SECRET, { now: () => NOW_MS, toleranceSeconds: 600 }),
    ).resolves.toBeTruthy();
  });

  it("rejects an event id already handled", async () => {
    const seen = new Set<string>();
    const options = { now: () => NOW_MS, seen: (id: string) => seen.has(id) };
    await verifyWebhook(BODY, headers(sign(BODY)), SECRET, options);
    seen.add(EVENT.id);
    expect(await code(verifyWebhook(BODY, headers(sign(BODY)), SECRET, options))).toBe("replayed_event");
  });

  it("rejects missing or malformed signatures and a missing secret", async () => {
    expect(await code(verifyWebhook(BODY, {}, SECRET))).toBe("missing_signature");
    expect(await code(verifyWebhook(BODY, headers("t=abc,v1=zz"), SECRET))).toBe("malformed_signature");
    expect(await code(verifyWebhook(BODY, headers(sign(BODY)), ""))).toBe("missing_secret");
  });

  it("rejects an event id header that disagrees with the signed body", async () => {
    expect(
      await code(verifyWebhook(BODY, headers(sign(BODY), "evt_other"), SECRET, { now: () => NOW_MS })),
    ).toBe("invalid_payload");
  });

  it("rejects a signed body that is not an approval event", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "approval.denied", created_at: "x", approval: {} });
    expect(
      await code(verifyWebhook(body, headers(sign(body), "evt_1"), SECRET, { now: () => NOW_MS })),
    ).toBe("invalid_payload");
  });

  it("is reachable as squire.webhooks.verify with the configured secret", async () => {
    const squire = new Squire({ webhookSecret: SECRET });
    const event = await squire.webhooks.verify(BODY, headers(sign(BODY)), { now: () => NOW_MS });
    expect(event.decision).toBe("denied");
  });
});
