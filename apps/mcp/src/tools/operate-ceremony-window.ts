// The connect ceremony alone uses this broker-only command. The broker owns
// the live page and CDP connection, so its caller never opens another Chrome.
import { z } from "zod";
import { sessionForCall } from "../bot/session/lifecycle.js";
import type { Tool } from "./index.js";

const ceremonyWindowSchema = z
  .object({
    session_id: z.string().min(1),
    action: z.enum(["show_phone", "restore"]),
  })
  .strict();

export const operateCeremonyWindowTool: Tool<z.infer<typeof ceremonyWindowSchema>> = {
  name: "operate_ceremony_window",
  description: "Internal broker-only connect ceremony window resize and restore. Not agent-facing.",
  inputSchema: ceremonyWindowSchema,
  async handler(args) {
    const session = sessionForCall(args.session_id);
    if (session === undefined) throw new Error(`unknown provision session ${args.session_id}`);
    if (args.action === "show_phone") return await session.browser.showPhoneCeremonyWindow();
    await session.browser.restoreCeremonyWindow();
    return { restored: true };
  },
};
