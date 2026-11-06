import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import type { Quote } from "../kernel/types.js";
import { runFixture } from "./run-fixture.js";

const FIXTURE = "fixtures/banquet-01.json";
let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

interface QuoteLine {
  label: string;
  amount: number;
  ruleId: string;
}

/** Numbers a reply may contain, derived independently from kernel output + fixture echo. */
function allowedNumbers(
  quote: { total: number; validUntil: string; lines: QuoteLine[] },
  fields: { guestCount: number; date: string },
): Set<string> {
  const allowed = new Set<string>();
  const addAmount = (minor: number) => {
    const major = Math.trunc(minor / 100);
    allowed.add(String(major));
    if (minor % 100 !== 0) allowed.add(String(Math.abs(minor % 100)));
  };
  addAmount(quote.total);
  for (const l of quote.lines) {
    addAmount(l.amount);
    for (const n of l.label.match(/\d+/g) ?? []) allowed.add(n);
  }
  for (const iso of [quote.validUntil, fields.date]) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    for (const n of [y, m, d]) allowed.add(String(Number(n)));
  }
  allowed.add(String(fields.guestCount));
  return allowed;
}

describe("runFixture (the seam behind `pnpm sim run`)", () => {
  it("produces a line-itemised quote reply from kernel numbers and stores a ledger row", async () => {
    const r = await runFixture(FIXTURE, { pool: db.pool });

    const q = r.quote as Quote;
    expect(q.kind).toBe("quote");
    expect(q.total).toBe(56_640_000);
    expect(r.reply).toContain("Hall hire (Fri-Sun)");
    expect(r.reply).toContain("₹2,50,000");
    expect(r.reply).toContain("GST 18%");
    expect(r.reply).toContain("₹5,66,400");
    expect(r.reply).toContain("14 Nov 2026");

    const { rows } = await db.pool.query(
      "SELECT * FROM ledger_entries WHERE seq = $1",
      [r.ledgerRow.seq],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("quote");
    expect(rows[0].tenant_id).toBe("tenant-rose-court");
    expect(rows[0].rate_card_hash).toBe(q.rateCardHash);
    expect(rows[0].payload.total).toBe(56_640_000);
    expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reply contains no number absent from kernel output", async () => {
    const r = await runFixture(FIXTURE, { pool: db.pool });
    const allowed = allowedNumbers(r.quote as Quote, { guestCount: r.fields.guestCount, date: r.fields.date });
    const found = (r.reply.match(/\d[\d,]*/g) ?? []).map((t) => t.replaceAll(",", ""));
    expect(found.length).toBeGreaterThan(5);
    const stray = found.filter((n) => !allowed.has(String(Number(n))));
    expect(stray).toEqual([]);
  });

  it("is byte-identical across 100 runs", async () => {
    const strip = (r: Awaited<ReturnType<typeof runFixture>>) =>
      JSON.stringify({
        reply: r.reply,
        quote: r.quote,
        row: { ...r.ledgerRow, seq: 0 },
      });
    const first = strip(await runFixture(FIXTURE, { pool: db.pool }));
    for (let i = 0; i < 100; i++) {
      expect(strip(await runFixture(FIXTURE, { pool: db.pool }))).toBe(first);
    }
  });

  it("never stores or prints a raw phone number", async () => {
    const r = await runFixture(FIXTURE, { pool: db.pool });
    const { rows } = await db.pool.query("SELECT phone_hash FROM customers");
    expect(rows[0].phone_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toMatch(/\+\d{10,}|\b[6-9]\d{9}\b/);
  });

  it("gives a safe holding reply, no numbers, on a refusal", async () => {
    const r = await runFixture(FIXTURE, {
      pool: db.pool,
      overrideFields: { guestCount: 900 },
    });
    expect(r.quote.kind).toBe("refusal");
    expect(r.reply).not.toMatch(/\d/);
    expect(r.ledgerRow.type).toBe("refusal");
  });
});

describe("migrations", () => {
  it("every table carries tenant_id NOT NULL", async () => {
    const { rows } = await db.pool.query<{ table_name: string; has: boolean }>(`
      SELECT t.table_name,
             EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                       AND c.column_name = 'tenant_id' AND c.is_nullable = 'NO') AS has
      FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND t.table_name <> 'schema_migrations'`);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.filter((r) => !r.has).map((r) => r.table_name)).toEqual([]);
  });
});
