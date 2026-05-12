/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Headers below are necessary for Vouchflow WebAuthn — the SDK calls
  // navigator.credentials.create/get, which require a secure context
  // and a stable RP ID. In dev (localhost) both are automatic.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  // Proxy /v1/* through the PWA origin to the API. The browser then
  // makes same-origin calls regardless of where the PWA is served
  // from (localhost, cloudflared tunnel, prod domain) — no CORS, no
  // separate API base URL to configure.
  //
  // Production deployments override this with API_PROXY_TARGET pointing
  // at the deployed API.
  async rewrites() {
    const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:3000";
    return [
      { source: "/v1/:path*", destination: `${apiTarget}/v1/:path*` },
      { source: "/health", destination: `${apiTarget}/health` },
    ];
  },
};

export default nextConfig;
