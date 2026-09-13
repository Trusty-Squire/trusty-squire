import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

export const listPaymentCardsTool: Tool = {
  name: "list_payment_cards",
  description:
    "List saved payment cards by opaque ID and user-visible label only. Never returns encrypted blobs or card data.",
  inputSchema: z.object({}),
  jsonInputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  async handler(_args, api) {
    assertApi(api);
    const cards = await api.listPaymentCards();
    return { cards: cards.map(({ id, label }) => ({ id, label })) };
  },
};
