import type { NextConfig } from "next";
import { join } from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace dependencies from the monorepo root so the standalone bundle
  // is complete when built inside the workspace.
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  // Same-origin proxy to the API so the browser ships the ts_session
  // cookie automatically — no CORS, no cross-site cookie attributes.
  //
  // rewrites() runs at BUILD time. Fly [env]/secrets are runtime-only,
  // so the API origin is resolved here from NODE_ENV (which `next build`
  // sets to "production") — not from a runtime var. API_PROXY_TARGET
  // still wins if it's present as a build-time env (staging, etc.).
  async rewrites() {
    const apiTarget =
      process.env.API_PROXY_TARGET ??
      (process.env.NODE_ENV === "production"
        ? "https://trusty-squire-api.fly.dev"
        : "http://localhost:3000");
    return [
      { source: "/v1/:path*", destination: `${apiTarget}/v1/:path*` },
      { source: "/health", destination: `${apiTarget}/health` },
    ];
  },
};

export default nextConfig;
