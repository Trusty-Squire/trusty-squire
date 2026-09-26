import { expect, it } from "vitest";
import { OPERATE_TOOLS as publicTools } from "../provision-drive-schema.js";
import { OPERATE_TOOLS as brokerTools } from "../provision-drive.js";
import { injectCardTool as publicCard } from "../inject-card-schema.js";
import { injectCardTool as brokerCard } from "../inject-card.js";

it("publishes the broker's exact operator metadata without loading handlers", () => {
  expect(publicTools.map((tool) => tool.name)).toEqual(brokerTools.map((tool) => tool.name));
  for (const publicTool of [...publicTools, publicCard]) {
    const brokerTool = [...brokerTools, brokerCard].find((tool) => tool.name === publicTool.name);
    expect(brokerTool).toBeDefined();
    expect({
      description: publicTool.description,
      jsonInputSchema: publicTool.jsonInputSchema,
      jsonOutputSchema: publicTool.jsonOutputSchema,
      annotations: publicTool.annotations,
      meta: publicTool.meta,
    }).toEqual({
      description: brokerTool?.description,
      jsonInputSchema: brokerTool?.jsonInputSchema,
      jsonOutputSchema: brokerTool?.jsonOutputSchema,
      annotations: brokerTool?.annotations,
      meta: brokerTool?.meta,
    });
  }
});
