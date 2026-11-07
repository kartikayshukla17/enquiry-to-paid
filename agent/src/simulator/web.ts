import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import { runChat } from "./chat.js";
import { REPO_ROOT } from "../ratecard/paths.js";

/**
 * Local-only HTTP seam for the web simulator page: POST /chat {text, customerRef?, tenantId?, card?} -> {reply, ledgerRow, held?}.
 * Same pipeline as `pnpm sim chat`; nothing here prices or words anything. Binds to 127.0.0.1 only.
 */
const PORT = Number(process.env.SIM_WEB_PORT ?? 4010);
const MAX_BODY = 8 * 1024;
// Allowlist = the fictional cards on disk (read from the directory, so no vertical is named here).
const CARDS = new Set(
  readdirSync(`${REPO_ROOT}rate-cards`)
    .filter((f) => /^fictional-.*\.json$/.test(f))
    .map((f) => `rate-cards/${f}`),
);

// Demo convenience only (same as `pnpm sim`): throwaway process-local keys when none are configured.
for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
await migrate(pool);

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

createServer(async (req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, provider: process.env.LLM_PROVIDER ?? "fixture", mode: process.env.LLM_MODE ?? "replay" });
    if (req.method !== "POST" || req.url !== "/chat") return send(404, { error: "not found" });
    const b = JSON.parse(await readBody(req)) as { text?: unknown; customerRef?: unknown; tenantId?: unknown; card?: unknown };
    if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) return send(400, { error: "text must be 1-1000 characters" });
    const customerRef = typeof b.customerRef === "string" && /^[a-z0-9-]{4,40}$/.test(b.customerRef) ? b.customerRef : "web-sim-customer";
    const card = typeof b.card === "string" && CARDS.has(b.card) ? b.card : undefined;
    // Each card gets its own tenant so threads and approvals never mix across verticals.
    const tenantId = card ? `tenant-web-${card.split("fictional-")[1]!.replace(".json", "")}` : "tenant-rose-court";
    const r = await runChat(b.text, { pool, tenantId, customerRef, ...(card && { card }) });
    return send(200, { reply: r.reply, ledgerRow: r.ledgerRow, ...(r.held && { held: true }) });
  } catch (e) {
    console.error(e instanceof Error ? e.message : "error"); // never log the message text
    return send(500, { error: "simulator error" });
  }
}).listen(PORT, "127.0.0.1", () => console.error(`sim web on http://127.0.0.1:${PORT} (LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "fixture"}, LLM_MODE=${process.env.LLM_MODE ?? "replay"})`));
