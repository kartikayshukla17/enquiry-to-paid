// Playground feedback proxy to the agent server (`pnpm serve`), same pattern as /api/sim.
const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:4010";

export async function POST(req: Request) {
  try {
    const r = await fetch(`${AGENT_URL}/feedback`, { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Agent server is not running. Start it with: pnpm serve" }, { status: 502 });
  }
}
