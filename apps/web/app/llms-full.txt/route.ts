import { buildLlmsFullTxt } from "../lib/llms-content";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildLlmsFullTxt(), {
    headers: {
      "cache-control": "public, max-age=0, s-maxage=86400",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
