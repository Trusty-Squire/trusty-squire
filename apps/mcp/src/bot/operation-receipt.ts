import { z } from "zod";

/** Metadata only. Never add page text, caller data, or credential material here. */
export const operationReceiptSchema = z
  .object({
    session_id: z.string(),
    operation_id: z.string(),
    execution: z.enum(["completed", "cancelled", "pending", "unknown"]),
    mutation: z.enum(["not_dispatched", "dispatched", "unknown"]),
    cleanup: z.enum(["open", "closing", "closed", "already_closed", "unknown"]),
    closed: z.boolean(),
  })
  .strict();
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
