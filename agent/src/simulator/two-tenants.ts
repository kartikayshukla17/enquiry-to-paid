import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { createLogNotifier } from "../escalation/index.js";
import { loadKernel } from "../kernel/index.js";
import type { Availability, ExtractedFields, TurnOutcome } from "../kernel/types.js";
import { handleEnquiry } from "../pipeline/handle-enquiry.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { seedApprovedCard } from "../ratecard/legacy.js";
import { loadCardSource } from "../ratecard/source.js";
import { resolveFixture } from "./run-fixture.js";

interface TwoTenantFixture {
  now: string;
  customerRef: string;
  availability: Availability;
  message: string;
  extracted: ExtractedFields;
  tenants: { tenant: { id: string; name: string }; rateCard: string }[];
}

export interface TwoTenantReport {
  tenants: { tenantId: string; reply: string; outcome: TurnOutcome }[];
  /** For each tenant table, what tenant 1 saw when it asked for tenant 2's rows. */
  crossReads: { reader: string; target: string; table: string; rows: number; allowed: boolean }[];
  /** True when tenant 1 inserting a row stamped with tenant 2's id was rejected by the WITH CHECK. */
  crossInsertRejected: boolean;
}

const CROSS_TABLES = ["threads", "rate_cards", "customers", "ledger_entries"] as const;

/** Runs one enquiry under each tenant of the fixture, then proves tenant 1 cannot reach tenant 2's data. */
export async function runTwoTenants(fixturePath: string, opts: { pool: Pool }): Promise<TwoTenantReport> {
  const fx = JSON.parse(await readFile(resolveFixture(fixturePath), "utf8")) as TwoTenantFixture;
  const kernel = await loadKernel();
  const tenants: TwoTenantReport["tenants"] = [];
  for (const t of fx.tenants) {
    const rateCard = await loadCardSource(t.rateCard, kernel);
    await seedApprovedCard({ pool: opts.pool, kernel }, { tenant: t.tenant, card: rateCard, now: fx.now });
    const res = await handleEnquiry(
      { pool: opts.pool, kernel, notifier: createLogNotifier() },
      {
        tenant: t.tenant,
        threadId: `${t.tenant.id}:thread:two-tenants`,
        customerRef: fx.customerRef,
        rateCard,
        now: fx.now,
        availability: fx.availability,
        message: fx.message,
        fields: { ...fx.extracted },
      },
    );
    tenants.push({ tenantId: t.tenant.id, reply: res.reply, outcome: res.outcome });
  }
  const [reader, target] = fx.tenants.map((t) => t.tenant.id);
  if (!reader || !target) throw new Error("two-tenants fixture needs two tenants");
  const crossReads: TwoTenantReport["crossReads"] = [];
  for (const table of CROSS_TABLES) {
    const rows = await withTenant(opts.pool, reader, async (c) => (await c.query(`SELECT 1 FROM ${table} WHERE tenant_id = $1`, [target])).rowCount ?? 0);
    crossReads.push({ reader, target, table, rows, allowed: rows > 0 });
  }
  let crossInsertRejected = false;
  try {
    await withTenant(opts.pool, reader, (c) =>
      c.query("INSERT INTO threads (id, tenant_id, customer_id) VALUES ($1,$2,$3)", [`forged-${target}`, target, `${reader}:cust:${fx.customerRef}`]),
    );
  } catch (e) {
    crossInsertRejected = /row-level security/.test((e as Error).message);
  }
  return { tenants, crossReads, crossInsertRejected };
}
