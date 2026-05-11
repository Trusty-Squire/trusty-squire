// SES inbound webhook route.
//
// AWS SES doesn't POST raw email here directly — it writes the RFC 822
// to S3 and publishes an SNS notification, and SNS POSTs the notification
// to this endpoint. Two SNS message types are relevant:
//   - SubscriptionConfirmation: returned during topic subscription;
//     the response is the value of the SubscribeURL field (operator
//     confirms the subscription out of band by visiting it).
//   - Notification: a real inbound email event; we parse the inner
//     SES message JSON and feed it to SesHandler.
//
// SNS signature verification is intentionally NOT in this minimal
// chunk-7 implementation — the Terraform setup (chunk-7 README) is
// expected to enforce mTLS / WAF in front of this endpoint and only
// allow SNS-originated traffic. Production hardening adds full SNS
// signature verification (per AWS docs) before chunk 7's pipe is
// pointed at real SES.

import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { SesHandler, SesInboundNotification } from "@trusty-squire/inbox";

interface SnsEnvelope {
  Type?: string;
  SubscribeURL?: string;
  Message?: string;
}

interface SesInboundMessage {
  notificationType: string;
  receipt?: { recipients?: string[] };
  mail?: {
    destination?: string[];
    messageId?: string;
  };
  // SES's inbound rule with S3 action populates this.
  receiptAction?: { type?: string; bucketName?: string; objectKey?: string };
}

export interface SesInboundRouteDeps {
  handler: SesHandler;
}

export const registerSesInboundRoute: FastifyPluginAsync<SesInboundRouteDeps> = async (
  fastify: FastifyInstance,
  opts,
) => {
  fastify.post("/webhooks/ses-inbound", async (request, reply) => {
    const envelope = request.body as SnsEnvelope;

    if (envelope.Type === "SubscriptionConfirmation") {
      // The Terraform-driven setup confirms manually via SubscribeURL;
      // log and 200 so SNS marks the delivery successful.
      request.log.info({ subscribeUrl: envelope.SubscribeURL }, "ses_subscription_pending");
      return reply.code(200).send({ ok: true, status: "subscription_pending_manual_confirm" });
    }

    if (envelope.Type !== "Notification" || envelope.Message === undefined) {
      return reply.code(400).send({ ok: false, error: "unsupported_sns_envelope" });
    }

    let inner: SesInboundMessage;
    try {
      inner = JSON.parse(envelope.Message) as SesInboundMessage;
    } catch (err) {
      request.log.error({ err }, "ses_inner_message_parse_failed");
      return reply.code(400).send({ ok: false, error: "invalid_inner_message" });
    }

    const bucketName = inner.receiptAction?.bucketName;
    const objectKey = inner.receiptAction?.objectKey;
    if (bucketName === undefined || objectKey === undefined) {
      return reply.code(400).send({ ok: false, error: "missing_s3_pointer" });
    }

    const recipients =
      inner.receipt?.recipients ?? inner.mail?.destination ?? [];

    const notification: SesInboundNotification = {
      bucket: bucketName,
      key: objectKey,
      ...(recipients.length > 0 ? { recipients } : {}),
    };

    const outcome = await opts.handler.ingest(notification);
    request.log.info({ outcome: outcome.kind }, "ses_inbound_processed");
    return reply.code(200).send({ ok: true, outcome: outcome.kind });
  });
};
