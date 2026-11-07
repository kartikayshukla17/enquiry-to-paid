// Dev-only proxy to the local simulator server (`pnpm sim:web`). Disabled outside development.
export const dynamic = "force-dynamic";

const SIM = `http://127.0.0.1:${process.env.SIM_WEB_PORT ?? "4010"}`;

export async function POST(req: Request) {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "not available" }, { status: 404 });
  try {
    const r = await fetch(`${SIM}/chat`, { method: "POST", body: await req.text(), headers: { "content-type": "application/json" } });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ error: "Simulator server is not running. Start it with: pnpm sim:web" }, { status: 502 });
  }
}

export async function GET() {
  if (process.env.NODE_ENV === "production") return Response.json({ error: "not available" }, { status: 404 });
  try {
    const r = await fetch(`${SIM}/health`);
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
  } catch {
    return Response.json({ ok: false }, { status: 502 });
  }
}
