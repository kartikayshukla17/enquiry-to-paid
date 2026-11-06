import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, ownerAc } from "better-auth/plugins/organization/access";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { withTenant } from "../tenancy/with-tenant.js";
import * as schema from "./schema.js";

export type OrgRole = "owner" | "manager" | "staff";

const ac = createAccessControl(defaultStatements);

/** owner: everything; manager: runs the org day to day but cannot delete it; staff: no org administration. */
export const roles = {
  owner: ownerAc,
  manager: ac.newRole({ organization: ["update"], member: ["create", "update"], invitation: ["create", "cancel"] }),
  staff: ac.newRole({}),
};

const isRole = (r: string): r is OrgRole => r === "owner" || r === "manager" || r === "staff";

export interface AuthOptions {
  /** Defaults to env BETTER_AUTH_SECRET. Never hard-code or commit one. */
  secret?: string;
  baseURL?: string;
}

/**
 * Better Auth with the organization plugin on Drizzle/Postgres.
 * organization -> tenant (organization.id IS the tenant id); organization member -> app `members` row
 * with role owner|manager|staff. The auth library connects as the owner role (see 0005_auth.sql for why
 * its tables are outside RLS); the mirror writes into tenant tables go through withTenant, i.e. RLS.
 */
export function createAuth(pool: Pool, opts: AuthOptions = {}) {
  const secret = opts.secret ?? process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  const db = drizzle(pool, { schema });

  // organization.id IS the tenant id. The plugin adds the creator as a member before the
  // create-organization hook runs, so the tenant row is ensured wherever a member is mirrored.
  const mirror = (org: { id: string; name: string }, m: { id: string; userId: string; role: string }) => {
    if (!isRole(m.role)) throw new Error(`unsupported role: ${m.role}`);
    return withTenant(pool, org.id, async (c) => {
      await c.query("INSERT INTO tenants (id, name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING", [org.id, org.name]);
      await c.query(
        `INSERT INTO members (id, tenant_id, role, user_id) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role`,
        [m.id, org.id, m.role, m.userId],
      );
    });
  };

  return betterAuth({
    secret,
    baseURL: opts.baseURL ?? "http://localhost:3000",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "owner",
        organizationHooks: {
          afterCreateOrganization: async ({ organization: org, member }) => {
            await mirror(org, member);
          },
          afterAddMember: async ({ member, organization: org }) => {
            await mirror(org, member);
          },
          afterUpdateMemberRole: async ({ member, organization: org }) => {
            await mirror(org, member);
          },
          afterRemoveMember: async ({ member, organization: org }) => {
            await withTenant(pool, org.id, (c) => c.query("DELETE FROM members WHERE id=$1", [member.id]));
          },
        },
      }),
    ],
  });
}

export type E2pAuth = ReturnType<typeof createAuth>;
