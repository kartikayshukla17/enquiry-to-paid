import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development only: Better Auth runs in the agent package (`pnpm auth:web`); the site proxies its routes
  // so the browser, cookies and the Google callback all stay on one origin (http://localhost:3000).
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const port = process.env.AUTH_WEB_PORT ?? "4011";
    return [{ source: "/api/auth/:path*", destination: `http://127.0.0.1:${port}/api/auth/:path*` }];
  },
};

export default nextConfig;
