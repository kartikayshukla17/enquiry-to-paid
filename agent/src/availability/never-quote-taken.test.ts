import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectingNotifier } from "../escalation/index.js";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { encryptPii, phoneHash, piiKeysFromEnv } from "../security/pii.js";
import { REPO_ROOT } from "../simulator/run-fixture.js";
import { runDueTimers } from "../timers/run.js";
import { handleOwnerCommand } from "./commands.js";
import { nativeAvailability } from "./native.js";

/** Small deterministic PRNG so a failing sequence replays from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let db: TestDb;
let kernel: KernelBridge;
let card: { version: number };

beforeAll(async () => {
  kernel = await loadKernel();
  card = JSON.parse(await readFile(path.join(REPO_ROOT, "rate-cards/fictional-banquet.json"), "utf8")) as { version: number };
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const DATES = ["2026-12-12", "2026-12-13", "2026-12-19"];
const CUSTOMERS = ["c1", "c2", "c3", "c4", "c5"];
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

describe("no quote is ever issued for an unavailable date (random operation sequences vs an independent model)", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i", async (seed) => {
    const rand = mulberry32(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const tenant = { id: `tenant-prop-${seed}`, name: "FICTIONAL: Property Hall" };
    const pii = piiKeysFromEnv();
    await db.pool.query("INSERT INTO tenants (id, name) VALUES ($1,$2)", [tenant.id, tenant.name]);
    await db.pool.query("INSERT INTO members (id, tenant_id, role, phone_hash, phone_enc) VALUES ($1,$2,'owner',$3,$4)", [`m-${seed}`, tenant.id, phoneHash(pii, "owner"), encryptPii(pii, "owner")]);

    // The model: what SHOULD be available, kept independently of the database.
    const blocks = new Set<string>();
    const holds = new Map<string, { date: string; expiresMs: number }>();
    let clock = Date.parse("2026-11-07T10:00:00Z");
    let quotes = 0;
    let taken = 0;

    for (let step = 0; step < 40; step++) {
      const roll = rand();
      if (roll < 0.55) {
        const customer = pick(CUSTOMERS);
        const date = pick(DATES);
        const free = !blocks.has(date) && ![...holds].some(([th, h]) => th !== customer && h.date === date && h.expiresMs > clock);
        const r = await handleEnquiry(
          { pool: db.pool, kernel, notifier: collectingNotifier([]), availability: nativeAvailability },
          {
            tenant, threadId: `${tenant.id}:th:${customer}`, customerRef: customer, rateCard: card, rateCardVersion: card.version,
            now: iso(clock), availability: { blockedDates: [] }, message: "m",
            fields: { service: "banquet", date, guestCount: 120, language: "en", confidenceBps: 9000 },
          },
        );
        if (r.outcome.kind === "quote") {
          quotes++;
          expect(free, `seed ${seed} step ${step}: quoted ${date} for ${customer} but the model says it is taken`).toBe(true);
          // Policy: asking again for the date you already hold does not extend the hold (no squatting by pinging).
          const prior = holds.get(customer);
          const keep = prior !== undefined && prior.date === date && prior.expiresMs > clock;
          if (!keep) holds.set(customer, { date, expiresMs: clock + 48 * 3_600_000 });
        } else {
          taken++;
          expect(r.outcome).toMatchObject({ kind: "refusal", reason: "date_unavailable" });
          expect(free, `seed ${seed} step ${step}: refused ${date} for ${customer} but the model says it is free`).toBe(false);
        }
      } else if (roll < 0.7) {
        const date = pick(DATES);
        await handleOwnerCommand({ pool: db.pool, kernel }, { tenant, senderRef: "owner", text: `block ${date} maintenance`, now: iso(clock) });
        blocks.add(date);
      } else if (roll < 0.8) {
        const date = pick(DATES);
        await handleOwnerCommand({ pool: db.pool, kernel }, { tenant, senderRef: "owner", text: `unblock ${date}`, now: iso(clock) });
        blocks.delete(date);
      } else if (roll < 0.9) {
        clock += Math.floor(rand() * 60) * 3_600_000; // 0..59h, sometimes crossing a hold's expiry
      } else {
        await runDueTimers(db.pool, iso(clock), { kernel });
      }
    }

    // Whatever happened, the database never holds one date twice at once.
    const { rows } = await db.pool.query(
      `SELECT a.id FROM holds a JOIN holds b ON a.id < b.id AND a.tenant_id=b.tenant_id AND a.resource_id=b.resource_id
       AND a.status='active' AND b.status='active' AND daterange(a.start_date,a.end_date,'[]') && daterange(b.start_date,b.end_date,'[]')
       WHERE a.tenant_id=$1`,
      [tenant.id],
    );
    expect(rows).toEqual([]);
    expect(quotes + taken).toBeGreaterThan(5);
  });

  it("the sequences exercise both outcomes overall", async () => {
    const { rows } = await db.pool.query("SELECT type, count(*)::int AS n FROM ledger_entries WHERE tenant_id LIKE 'tenant-prop-%' AND type IN ('quote','refusal') GROUP BY type");
    const by = Object.fromEntries(rows.map((r) => [r.type, r.n]));
    expect(by.quote).toBeGreaterThan(5);
    expect(by.refusal).toBeGreaterThan(5);
  });
});
