import { z } from "zod";
import { shareOperateSession } from "../bot/live-share.js";
import { withProvisionSessionCall } from "../bot/session/lifecycle.js";
import type { Tool } from "./index.js";

const shareSchema = z.object({ session_id: z.string().min(1) }).strict();

export const operateShareTool: Tool<z.infer<typeof shareSchema>> = {
  name: "operate_share",
  description:
    "Create an interactive live view of this operate session's tab for a human handoff. " +
    "The URL is a bearer capability: pass it only to a trusted server-side proxy, never publish it directly. " +
    "The first human input pauses agent actions until the viewer disconnects. The link ends when the session ends; repeating the call renews expires_at.",
  inputSchema: shareSchema,
  async handler(args) {
    return await withProvisionSessionCall(
      args.session_id,
      async (session) => await shareOperateSession(session),
    );
  },
};
