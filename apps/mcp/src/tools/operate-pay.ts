import { z } from "zod";
import { activeProvisionBrowser } from "../bot/provision-session.js";
import { executeOperatePay } from "../bot/pay-operator.js";
import { assertApi, type Tool } from "./index.js";

const inputSchema = z.object({
  merchant: z.string().min(1).max(256).optional(),
  amount_cents: z.number().int().min(0).max(2_147_483_647).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
  card_ref: z.string().min(1).max(64),
});

export const operatePayTool: Tool<z.infer<typeof inputSchema>> = {
  name: "operate_pay",
  description:
    "Pay the checkout in the one active operate_start browser session. Reads the live " +
    "merchant and total when present, creates a phone approval link, waits for approval, " +
    "verifies the high-confidence purchase mandate, opens the card only in this process, " +
    "fills common checkout fields, submits, and audits only the last four digits. Never " +
    "solves 3-D Secure; returns a needs_user handoff when issuer authentication appears.",
  inputSchema,
  jsonInputSchema: {
    type: "object",
    required: ["card_ref"],
    properties: {
      merchant: { type: "string" },
      amount_cents: { type: "integer", minimum: 0 },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      card_ref: { type: "string" },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
  async handler(args, api, context) {
    assertApi(api);
    return await executeOperatePay(
      {
        card_ref: args.card_ref,
        ...(args.merchant !== undefined ? { merchant: args.merchant } : {}),
        ...(args.amount_cents !== undefined ? { amount_cents: args.amount_cents } : {}),
        ...(args.currency !== undefined ? { currency: args.currency } : {}),
      },
      api,
      activeProvisionBrowser(),
      context !== undefined
        ? {
            surfaceApprovalUrl: async (url) => {
              await context.notifyUser(`Approve this payment on your phone: ${url}`, {
                approval_url: url,
              });
            },
          }
        : {},
    );
  },
};
