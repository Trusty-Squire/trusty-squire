import { describe, expect, it } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js";
import { buildBrokerToolRegistry } from "../index.js";
import { inputJsonSchema } from "../input-json-schema.js";

const tools = buildBrokerToolRegistry({ TRUSTY_SQUIRE_DIAGNOSTICS: "1" });

function advertised(name: string) {
  const tool = tools.find((entry) => entry.name === name)!;
  return inputJsonSchema(tool.inputSchema);
}

describe("generated tool input schemas", () => {
  it("advertises only object roots with explicit properties", () => {
    for (const tool of tools) {
      const schema = inputJsonSchema(tool.inputSchema);
      expect(schema, tool.name).toMatchObject({ type: "object" });
      expect(schema.properties, tool.name).toBeTypeOf("object");
      expect(schema.anyOf, tool.name).toBeUndefined();
      expect(schema.oneOf, tool.name).toBeUndefined();
    }
  });

  it("advertises Zod's inbox index and upload path bounds", () => {
    const validator = new AjvJsonSchemaValidator();
    const inbox = validator.getValidator(advertised("operate_read_inbox") as JsonSchemaType);
    const upload = validator.getValidator(advertised("operate_upload") as JsonSchemaType);
    expect(inbox({ session_id: "s", pick: 9 }).valid).toBe(true);
    expect(inbox({ session_id: "s", pick: 10 }).valid).toBe(false);
    expect(upload({ session_id: "s", target: "e1", path: "/tmp/file" }).valid).toBe(true);
    expect(upload({ session_id: "s", target: "e1", path: "relative/file" }).valid).toBe(false);
  });

  it("preserves the supported capture source variants", () => {
    const sourceVariants = (name: string) => {
      const properties = advertised(name).properties as Record<string, unknown>;
      const capture = properties.capture as { properties: { source: { anyOf: unknown[] } } };
      return capture.properties.source.anyOf;
    };
    expect(sourceVariants("operate_click")).toHaveLength(3);
    expect(sourceVariants("operate_extract")).toHaveLength(2);
  });
});
