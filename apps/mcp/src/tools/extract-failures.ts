// MCP tools for inspecting extract-failure snapshots.
//
// These tools exist so a coding agent (Goose, Claude Code, etc.) can
// pull a freshly-uploaded DOM + screenshot into its context window
// IMMEDIATELY after a signup fails — no curl, no jq, no token
// shell-juggling. The flow becomes:
//
//   1. User: "create a Railway API key"
//   2. Bot runs, extract fails, auto-uploads snapshot
//   3. User: "diagnose the failure"
//   4. Agent: list_extract_failures → get_extract_failure(<id>)
//   5. Agent inspects the HTML in-context and writes a targeted fix
//
// Two tools so the agent doesn't blow its context on a 300KB HTML
// blob it doesn't need yet:
//
//   - list_extract_failures: cheap, metadata-only, shows recent
//     failures with id/service/url so the agent can pick one.
//   - get_extract_failure: pulls the full HTML + base64 screenshot
//     for one specific id.

import { z } from "zod";
import { assertApi, type Tool } from "./index.js";

const ListInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max snapshots to return (default 10, max 50)"),
});

export const listExtractFailuresTool: Tool<z.infer<typeof ListInputSchema>> = {
  name: "list_extract_failures",
  description:
    "List recent extract-failure diagnostic snapshots uploaded by the universal signup bot. " +
    "When a signup completes but `extractCredentials()` returned null (the bot saw the token " +
    "in the screenshot but the regex extractor couldn't find it in the DOM), the bot auto- " +
    "uploads the DOM + screenshot to the registry. Use this tool to discover what snapshots " +
    "exist; then call `get_extract_failure` with an id to pull the actual HTML + screenshot. " +
    "Returns metadata only — id, service, url, step_label, upload time, byte sizes. " +
    "Snapshots auto-expire after 7 days.",
  inputSchema: ListInputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max snapshots to return (default 10, max 50)",
        minimum: 1,
        maximum: 50,
      },
    },
  },
  async handler(args, api) {
    assertApi(api);
    const limit = args.limit ?? 10;
    return api.listExtractFailures(limit);
  },
};

const GetInputSchema = z.object({
  id: z.string().min(1).describe("Snapshot id (from list_extract_failures)"),
  include_screenshot: z
    .boolean()
    .optional()
    .describe(
      "If true, include base64 JPEG screenshot in the response. Default false " +
        "to keep the response small — only set true when you need to see the page " +
        "visually, not just inspect the DOM.",
    ),
});

export const getExtractFailureTool: Tool<z.infer<typeof GetInputSchema>> = {
  name: "get_extract_failure",
  description:
    "Fetch the full DOM (and optionally the screenshot) of one extract-failure snapshot. " +
    "Returns the decompressed HTML, the URL/title context, the LLM's `extract_reason` (the " +
    "prose that triggered the extract step — usually contains the literal token), and the " +
    "candidate strings the bot's extractCredentialCandidates() returned. Use this to find " +
    "what DOM element holds the credential the regex extractor missed, then write a " +
    "targeted fix. `include_screenshot: false` by default to save context; set true to also " +
    "get the JPEG bytes the LLM planner saw.",
  inputSchema: GetInputSchema,
  jsonInputSchema: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Snapshot id (from list_extract_failures)",
      },
      include_screenshot: {
        type: "boolean",
        description:
          "If true, include base64 JPEG screenshot in the response. Default false.",
      },
    },
    required: ["id"],
  },
  async handler(args, api) {
    assertApi(api);
    const full = await api.getExtractFailure(args.id);
    if (args.include_screenshot === true) return full;
    // Strip the screenshot to keep the response small. The agent
    // can re-call with `include_screenshot: true` if it needs the
    // visual.
    const { screenshot_jpeg_base64: _unused, ...withoutScreenshot } = full;
    void _unused;
    return {
      ...withoutScreenshot,
      screenshot_omitted: full.screenshot_jpeg_base64 !== null,
    };
  },
};
