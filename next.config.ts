import type { NextConfig } from "next";

// The agent runs as one process (`pnpm serve`, agent/src/server/serve.ts) exposing Better Auth, the chat/payment
// webhooks and the playground under one base URL. Locally that's the sidecar on 127.0.0.1:4010; deployed, it's the
// agent's own public URL (e.g. the Render service), set via AGENT_URL. Vercel proxies to it server-side (a plain
// rewrite), so the browser only ever talks to this site's own origin and the Google OAuth callback stays on it too.
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:4010";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${AGENT_URL}/api/auth/:path*` },
      { source: "/api/app/:path*", destination: `${AGENT_URL}/api/app/:path*` },
      { source: "/api/webhooks/payments/:provider", destination: `${AGENT_URL}/webhooks/payments/:provider` },
    ];
  },
};

export default nextConfig;
