import { createServer, type Server } from "node:http";
import { toNodeHandler } from "better-auth/node";
import type { Pool } from "pg";
import { createAuth, type AuthOptions } from "./index.js";

/** Plain HTTP server exposing Better Auth under /api/auth/*. The Next site proxies to it in development. */
export function createAuthServer(pool: Pool, opts: AuthOptions = {}): Server {
  const handler = toNodeHandler(createAuth(pool, opts));
  return createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (!req.url?.startsWith("/api/auth/")) {
      res.writeHead(404).end();
      return;
    }
    void handler(req, res);
  });
}
