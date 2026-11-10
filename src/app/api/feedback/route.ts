// Playground feedback proxy to the local simulator server (`pnpm sim:web`), same pattern as /api/sim.
const SIM = `http://127.0.0.1:${process.env.SIM_WEB_PORT ?? "4010"}`;

export async function POST(req: Request) {
  try {
    const r = await fetch(`${SIM}/feedback`, { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Simulator server is not running. Start it with: pnpm sim:web" }, { status: 502 });
  }
}
