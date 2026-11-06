import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import type { Quote } from "../kernel/types.js";
import { REFUSAL_REASONS } from "../kernel/types.js";
import { collectingNotifier, createLogNotifier, describeReason, type EscalationEvent } from "../escalation/index.js";
import { holdingReply } from "../pipeline/reply.js";
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
        // position in the chain (seq, tenantSeq, prevHash, hash) legitimately differs per run
        row: { ...r.ledgerRow, seq: 0, tenantSeq: 0, prevHash: "", hash: "" },
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

describe("refusal path (300 guests in a month the card does not cover)", () => {
  const REFUSAL_FIXTURE = "fixtures/wedding-300-out-of-season.json";

  it("returns a typed refusal with the rule gap, a price-free holding reply and a refusal ledger row", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture(REFUSAL_FIXTURE, { pool: db.pool, notifier: collectingNotifier(events) });

    expect(r.quote).toEqual({ kind: "refusal", reason: "no_covering_rule", ruleGap: "date,guestCount" });
    expect(r.reply).not.toMatch(/\d/);
    expect(r.reply).not.toMatch(/₹|rs\.?\s/i);
    expect(r.ledgerRow.type).toBe("refusal");
    expect(r.ledgerRow.payload).toEqual(r.quote);

    const { rows } = await db.pool.query("SELECT state FROM threads WHERE id = $1", [r.ledgerRow.threadId]);
    expect(rows[0].state).toBe("refused");
  });

  it("emits exactly one escalation event with reason, ruleGap and typed fields, and no raw phone", async () => {
    const events: EscalationEvent[] = [];
    const r = await runFixture(REFUSAL_FIXTURE, { pool: db.pool, notifier: collectingNotifier(events) });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenantId: "tenant-marigold-hall",
      threadId: r.ledgerRow.threadId,
      reason: "no_covering_rule",
      ruleGap: "date,guestCount",
      fields: { service: "banquet", date: "2027-06-13", guestCount: 300 },
    });
    expect(JSON.stringify(events)).not.toMatch(/\+\d{10,}|\b[6-9]\d{9}\b/);
  });

  it("the stub notifier logs one line with reason, ruleGap and fields", async () => {
    const lines: string[] = [];
    await runFixture(REFUSAL_FIXTURE, { pool: db.pool, notifier: createLogNotifier((l) => lines.push(l)) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("reason=no_covering_rule");
    expect(lines[0]).toContain("ruleGap=date,guestCount");
    expect(lines[0]).toContain('"guestCount":300');
    expect(lines[0]).not.toMatch(/\+\d{10,}|\b[6-9]\d{9}\b/);
  });

  it("does not escalate when a quote is issued", async () => {
    const events: EscalationEvent[] = [];
    await runFixture(FIXTURE, { pool: db.pool, notifier: collectingNotifier(events) });
    expect(events).toEqual([]);
  });

  it("every refusal reason has a price-free holding reply and an escalation summary", () => {
    for (const reason of REFUSAL_REASONS) {
      const text = holdingReply(reason);
      expect(text).not.toMatch(/\d/);
      expect(text.length).toBeGreaterThan(20);
      expect(describeReason(reason).length).toBeGreaterThan(5);
    }
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
