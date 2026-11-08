import pg from "pg";
import { migrate } from "../ledger/migrate.js";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { createAuthServer } from "./server.js";

const port = Number(process.env.AUTH_WEB_PORT ?? 4011);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max: 4 });
await migrate(pool);
createAuthServer(pool).listen(port, "127.0.0.1", () => {
  const g = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "on" : "off";
  console.log(`auth on http://127.0.0.1:${port} (google sign-in: ${g}, base ${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"})`);
});
