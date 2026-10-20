import { z } from "zod";
import type { Tool } from "./index.js";
import { withProvisionSessionCall } from "../bot/session/lifecycle.js";
import { observeSession } from "../bot/observe/observe.js";
import { withAgentShareControl } from "../bot/live-share.js";
import { markOperatorMutationDispatchAttempted } from "../bot/request-cancellation.js";

const schema = z
  .object({
    session_id: z.string().min(1),
    dialog_id: z.string().uuid(),
    action: z.enum(["accept", "dismiss"]),
    text: z.string().max(4096).optional(),
  })
  .strict();

export const operateDialogTool: Tool<z.infer<typeof schema>> = {
  name: "operate_dialog",
  description:
    "Answer an observed native browser alert, confirm, prompt or beforeunload by its dialog id. Choose accept or dismiss explicitly; text is only for accepting a prompt. Confirm destructive actions only when authorized by the user's goal. Dialogs expire after two minutes and are dismissed, never automatically accepted.",
  inputSchema: schema,
  async handler(args) {
    return await withProvisionSessionCall(
      args.session_id,
      async (session) =>
        await withAgentShareControl(session, async () => {
          await markOperatorMutationDispatchAttempted();
          await session.browser.nativeDialogs.answer(args.dialog_id, args.action, args.text);
          return await observeSession(session, "compact", undefined, undefined, false, "compact");
        }),
    );
  },
};
