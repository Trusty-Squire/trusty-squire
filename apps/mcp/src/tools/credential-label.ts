import { z } from "zod";

export const credentialLabelSchema = z.string().trim().min(1).max(60);
