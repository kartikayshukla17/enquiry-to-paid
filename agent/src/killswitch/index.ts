/**
 * Kill switch (T28): a refuse-everything flag, global (platform) and per tenant.
 *
 * `readKillSwitch` is what the pipeline calls at the start of every decision (inside its tenant transaction, as the app
 * role). `setKillSwitch` is the only writer: it checks who is flipping, changes the flag and appends a
 * `kill_switch_changed` ledger entry (who, when, on/off, scope) in the same transaction, so a flip is never unrecorded.
 */
import type { Pool, PoolClient } from "pg";
import type { KernelBridge } from "../kernel/index.js";
import { appendEntry } from "../ledger/index.js";
import { withTenant } from "../tenancy/with-tenant.js";

export type KillScope = "global" | "tenant";
export type KillState = { on: false } | { on: true; scope: KillScope };

/** Tenant scope: a member of that tenant, whose role is checked against `members`. Global scope: a platform operator (owner DB role). */
export type KillActor = { memberId: string } | { operator: string };
export type KillTarget = { kind: "global" } | { kind: "tenant"; tenantId: string };

export class KillSwitchError extends Error {
  constructor(public readonly code: "not_owner" | "unknown_member" | "operator_required", detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

/** Global flag wins; otherwise the tenant's own flag; a tenant with no row is off. */
export async function readKillSwitch(client: PoolClient, tenantId: string): Promise<KillState> {
  const g = await client.query<{ on_flag: boolean }>("SELECT on_flag FROM kill_switch_global WHERE id");
  if (g.rows[0]?.on_flag) return { on: true, scope: "global" };
  const t = await client.query<{ on_flag: boolean }>("SELECT on_flag FROM tenant_kill_switch WHERE tenant_id = $1", [tenantId]);
  return t.rows[0]?.on_flag ? { on: true, scope: "tenant" } : { on: false };
}

export interface FlipDeps {
  /** Owner-role pool (like `ledger verify` and the timer worker): a global flip must see and write every tenant's chain. */
  pool: Pool;
  kernel: KernelBridge;
}

export interface FlipInput {
  target: KillTarget;
  on: boolean;
  actor: KillActor;
  now: string;
}

/**
 * Only an owner may flip. Tenant scope: the actor must be a member of that tenant with role `owner` (managers and staff
 * cannot). Global scope: a platform operator, i.e. someone holding the owner DB connection (the CLI); no tenant role suffices,
 * because one tenant's owner must not be able to stop every other tenant.
 */
export async function setKillSwitch(deps: FlipDeps, input: FlipInput): Promise<{ changed: boolean }> {
  const { target, on, actor, now } = input;
  const at = new Date(now).toISOString();
  if (target.kind === "tenant") {
    if (!("memberId" in actor)) throw new KillSwitchError("not_owner", "tenant scope needs an owner member");
    const memberId = actor.memberId;
    return withTenant(deps.pool, target.tenantId, async (c) => {
      const m = (await c.query<{ role: string }>("SELECT role FROM members WHERE id = $1", [memberId])).rows[0];
      if (!m) throw new KillSwitchError("unknown_member", memberId);
      if (m.role !== "owner") throw new KillSwitchError("not_owner", `role ${m.role}`);
      const prev = (await c.query<{ on_flag: boolean }>("SELECT on_flag FROM tenant_kill_switch WHERE tenant_id = $1 FOR UPDATE", [target.tenantId])).rows[0]?.on_flag ?? false;
      await c.query(
        `INSERT INTO tenant_kill_switch (tenant_id, on_flag, changed_at, changed_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id) DO UPDATE SET on_flag = $2, changed_at = $3, changed_by = $4`,
        [target.tenantId, on, at, memberId],
      );
      await appendEntry(c, deps.kernel, {
        tenantId: target.tenantId, threadId: null, at, type: "kill_switch_changed",
        payload: { scope: "tenant", on, previous: prev, actor: { memberId } },
      });
      return { changed: prev !== on };
    });
  }
  if (!("operator" in actor) || actor.operator.trim() === "") throw new KillSwitchError("operator_required", "global scope needs a platform operator");
  const operator = actor.operator;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const prev = (await client.query<{ on_flag: boolean }>("SELECT on_flag FROM kill_switch_global WHERE id FOR UPDATE")).rows[0]?.on_flag ?? false;
    await client.query("UPDATE kill_switch_global SET on_flag = $1, changed_at = $2, changed_by = $3 WHERE id", [on, at, operator]);
    // A global flip is recorded on every tenant's chain, so each tenant can see it in its own audit trail.
    const tenants = (await client.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows;
    for (const t of tenants) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [t.id]);
      await appendEntry(client, deps.kernel, {
        tenantId: t.id, threadId: null, at, type: "kill_switch_changed",
        payload: { scope: "global", on, previous: prev, actor: { operator } },
      });
    }
    await client.query("COMMIT");
    return { changed: prev !== on };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
