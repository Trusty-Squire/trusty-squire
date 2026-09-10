import { z } from "zod";

export const captureSourceSchema = z
  .object({
    role: z.enum(["textbox", "code"]),
    name: z.string().max(200).optional(),
    container: z
      .object({
        role: z.enum(["dialog", "region"]),
        name: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const captureEvidenceSchema = z
  .object({
    write_id: z.string().min(1).max(128),
    stored: z.boolean(),
    storage: z.enum(["stored", "unknown"]),
    reference: z.string().max(512).optional(),
  })
  .strict();
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
