// Broker-only internal read: fetch a URL through the owned browser context's
// APIRequestContext and return the final response. It is deliberately NOT in
// the agent-facing registry (see buildBrokerToolRegistry in ./index.ts): the
// only caller is the connect preflight's Google-liveness probe, which must ask
// the SAME browser context that owns the profile's cookies rather than a
// second network client with a different jar. Sharing the context is the whole
// point: the request egresses through the context's proxy and cookie jar, so a
// 401 here is the profile's real server-side answer.
//
// A null result from BrowserController.fetchText (any failure) becomes an
// explicit all-null payload; the caller treats that as "could not check", never
// as "signed out".

import { z } from "zod";
import { sessionForCall } from "../bot/session/lifecycle.js";
import type { Tool } from "./index.js";

const fetchTextSchema = z
  .object({
    session_id: z.string().min(1),
    url: z.string().url(),
  })
  .strict();

export const operateFetchTextTool: Tool<z.infer<typeof fetchTextSchema>> = {
  name: "operate_fetch_text",
  description:
    "Internal broker-only read: fetch a URL's final response (following redirects) " +
    "through the owned browser context's shared cookie jar and proxy, and return " +
    "the status, final URL, and body text. Not agent-facing.",
  inputSchema: fetchTextSchema,
  jsonInputSchema: {
    type: "object",
    required: ["session_id", "url"],
    properties: {
      session_id: { type: "string" },
      url: { type: "string" },
    },
  },
  annotations: { readOnlyHint: true },
  async handler(args) {
    const session = sessionForCall(args.session_id);
    if (session === undefined) {
      throw new Error(`unknown provision session ${args.session_id}`);
    }
    const fetched = await session.browser.fetchText(args.url);
    if (fetched === null) return { status: null, final_url: null, body_text: null };
    return { status: fetched.status, final_url: fetched.finalUrl, body_text: fetched.bodyText };
  },
};