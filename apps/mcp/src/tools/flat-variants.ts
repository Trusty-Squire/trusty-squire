import { z } from "zod";

/** Object-root discovery with the original branch parser as the runtime authority.
 * In particular, strict branches still reject fields belonging to other modes,
 * and stripping branches retain their existing unknown-field behavior.
 */
export function flatVariants<T extends Record<string, z.ZodTypeAny>>(
  variants: T,
  discriminatorInBranch = false,
) {
  const names = Object.keys(variants) as [string, ...string[]];
  let allStrict = true;
  const fields: Record<string, z.ZodTypeAny[]> = {};
  for (const branch of Object.values(variants)) {
    let object = branch;
    while (object instanceof z.ZodEffects) object = object.innerType();
    if (!(object instanceof z.ZodObject)) throw new Error("Variant must parse an object");
    allStrict &&= object._def.unknownKeys === "strict";
    for (const [key, field] of Object.entries(object.shape)) {
      if (key !== "action") (fields[key] ??= []).push(field as z.ZodTypeAny);
    }
  }
  const shape: z.ZodRawShape = { action: z.enum(names) };
  for (const [key, alternatives] of Object.entries(fields)) {
    const field =
      alternatives.length === 1
        ? alternatives[0]!
        : z.union(alternatives as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    shape[key] =
      alternatives.length === names.length && alternatives.every((v) => !v.isOptional())
        ? field
        : field.optional();
  }
  const input = allStrict ? z.object(shape).strict() : z.object(shape).passthrough();
  return z
    .preprocess((value) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      const record = value as Record<string, unknown>;
      let branch = variants[String(record.action)];
      while (branch instanceof z.ZodEffects) branch = branch.innerType();
      // Strip the selected branch's unknown fields before validating discovery
      // fields from other modes. Strict branches are left intact for rejection.
      if (branch instanceof z.ZodObject && branch._def.unknownKeys === "strip")
        return Object.fromEntries(
          Object.entries(record).filter(([key]) => key === "action" || key in branch.shape),
        );
      return value;
    }, input)
    .transform((value, ctx): z.output<T[keyof T]> & { action: keyof T } => {
      const { action, ...rest } = value;
      const parsed = variants[action!]!.safeParse(discriminatorInBranch ? value : rest);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue(issue);
        return z.NEVER;
      }
      return { ...parsed.data, action };
    });
}

/** Reject retired spellings without changing the object's handling of other keys. */
export function rejectRemovedFields<T extends z.ZodTypeAny>(
  schema: T,
  fields: readonly string[],
  message: string,
) {
  return z.preprocess((value, ctx) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(value, field))
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
      }
    }
    return value;
  }, schema);
}
