import { z } from "zod";

const captureContainerSchema = z
  .object({
    role: z.enum(["dialog", "region"]),
    name: z.string().max(200).optional(),
  })
  .strict()
  .optional();

export const captureSourceSchema = z.union([
  z
    .object({
      role: z.enum(["textbox", "code"]),
      name: z.string().max(200).optional(),
      container: captureContainerSchema,
    })
    .strict(),
  z
    .object({
      selector: z.string().min(1).max(2000),
      container: captureContainerSchema,
    })
    .strict(),
]);
export type CaptureSource = z.infer<typeof captureSourceSchema>;

export const captureEvidenceSchema = z
  .object({
    write_id: z.string().min(1).max(128),
    binding: z.string().optional(),
    stored: z.boolean(),
    storage: z.enum(["stored", "unknown", "not_attempted"]),
    reference: z.string().max(512).optional(),
  })
  .strict();
export type CaptureEvidence = z.infer<typeof captureEvidenceSchema>;
