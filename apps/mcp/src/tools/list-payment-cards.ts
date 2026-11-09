import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

export const listPaymentCardsTool: Tool = {
  name: "list_payment_cards",
  description:
    "List saved payment cards by opaque ID, user-visible label, and last4. Use last4 to distinguish cards with the same label; null means the legacy card has no stored last four digits. Never returns encrypted blobs or full card numbers.",
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true },
  async handler(_args, api) {
    assertApi(api);
    const cards = await api.listPaymentCards();
    return { cards: cards.map(({ id, label, last4 }) => ({ id, label, last4 })) };
  },
};
