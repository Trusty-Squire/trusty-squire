import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** The MCP list response advertises the same input that the handler parses. */
export function inputJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
    effectStrategy: "input",
    // A default Zod object strips unknown keys while accepting the call.
    // Keep the advertised schema permissive for those objects; .strict()
    // objects still advertise additionalProperties: false.
    removeAdditionalStrategy: "strict",
  }) as Record<string, unknown>;
  delete json.$schema;
  // Zod 3 stores field guidance in descriptions. Preserve the JSON Schema
  // deprecation annotation for fields whose Zod description marks them so.
  const markDeprecated = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(markDeprecated);
      return;
    }
    const field = value as Record<string, unknown>;
    if (typeof field.description === "string" && field.description.startsWith("Deprecated")) {
      field.deprecated = true;
    }
    Object.values(field).forEach(markDeprecated);
  };
  markDeprecated(json);
  // MCP inputSchema requires an object at the root. Zod unions of object
  // variants have an implicit object type but the converter omits the keyword.
  if (json.type === undefined) json.type = "object";
  return json;
}
