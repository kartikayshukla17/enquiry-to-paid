// Proxy to the agent server (`pnpm serve`), which runs as a sidecar process both in development and in the
// deployed playground. The agent itself enforces the daily per-visitor cap; this route only forwards.
export const dynamic = "force-dynamic";

const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:4010";

export async function POST(req: Request) {
  try {
    // Forwarded so the agent's per-visitor daily cap sees the real caller, not this server's own address.
    const fwd = req.headers.get("x-forwarded-for") ?? "";
    const r = await fetch(`${AGENT_URL}/chat`, { method: "POST", body: await req.text(), headers: { "content-type": "application/json", "x-forwarded-for": fwd } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Agent server is not running. Start it with: pnpm serve" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  try {
    const q = new URL(req.url).searchParams;
    const r = await fetch(q.has("customerRef") ? `${AGENT_URL}/payment-status?${q.toString()}` : `${AGENT_URL}/health`);
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false }, { status: 502 });
  }
}
