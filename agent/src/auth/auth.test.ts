import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { createAuth, roles, type E2pAuth } from "./index.js";

let db: TestDb;
let auth: E2pAuth;

beforeAll(async () => {
  db = await createTestDb();
  auth = createAuth(db.pool);
});
afterAll(async () => {
  await db.drop();
});

async function signUp(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `${name}@example.test`, password: "fictional-pass-123" } });
  return r.user.id;
}

describe("Better Auth organization -> tenant, members -> roles", () => {
  it("creating an organization creates the tenant with the same id; members map to owner/manager/staff", async () => {
    const [owner, manager, staff] = [await signUp("olive"), await signUp("mina"), await signUp("sam")];
    const org = await auth.api.createOrganization({ body: { name: "FICTIONAL: Org One", slug: "org-one", userId: owner } });
    await auth.api.addMember({ body: { organizationId: org.id, userId: manager, role: "manager" } });
    await auth.api.addMember({ body: { organizationId: org.id, userId: staff, role: "staff" } });

    // organization.id == tenant id
    const tenants = await db.pool.query("SELECT id, name FROM tenants WHERE id=$1", [org.id]);
    expect(tenants.rows).toEqual([{ id: org.id, name: "FICTIONAL: Org One" }]);

    // the app-level members table (RLS-protected) mirrors the auth roles
    const mine = await withTenant(db.pool, org.id, (c) => c.query("SELECT user_id, role FROM members ORDER BY role"));
    expect(Object.fromEntries(mine.rows.map((r) => [r.user_id, r.role]))).toEqual({
      [owner]: "owner",
      [manager]: "manager",
      [staff]: "staff",
    });
  });

  it("a second organization is a separate tenant and cannot see the first one's members", async () => {
    const other = await signUp("otto");
    const org2 = await auth.api.createOrganization({ body: { name: "FICTIONAL: Org Two", slug: "org-two", userId: other } });
    const seen = await withTenant(db.pool, org2.id, (c) => c.query("SELECT user_id FROM members"));
    expect(seen.rows).toEqual([{ user_id: other }]);
  });

  it("changing a member's role updates the app-level role", async () => {
    const [o, m] = [await signUp("rhea"), await signUp("raj")];
    const org = await auth.api.createOrganization({ body: { name: "FICTIONAL: Org Three", slug: "org-three", userId: o } });
    const added = await auth.api.addMember({ body: { organizationId: org.id, userId: m, role: "staff" } });
    await auth.api.updateMemberRole({ body: { organizationId: org.id, memberId: added.id, role: "manager" } , asResponse: false, headers: await ownerHeaders(o) });
    const row = await withTenant(db.pool, org.id, (c) => c.query("SELECT role FROM members WHERE user_id=$1", [m]));
    expect(row.rows[0].role).toBe("manager");
  });

  it("rejects roles outside owner/manager/staff", async () => {
    const [o, x] = [await signUp("ola"), await signUp("xan")];
    const org = await auth.api.createOrganization({ body: { name: "FICTIONAL: Org Four", slug: "org-four", userId: o } });
    await expect(auth.api.addMember({ body: { organizationId: org.id, userId: x, role: "admin" as never } })).rejects.toThrow();
  });

  it("role permissions: staff cannot manage the org, manager can invite, owner can delete", () => {
    expect(roles.staff.authorize({ organization: ["update"] }).success).toBe(false);
    expect(roles.staff.authorize({ invitation: ["create"] }).success).toBe(false);
    expect(roles.manager.authorize({ invitation: ["create"] }).success).toBe(true);
    expect(roles.manager.authorize({ organization: ["delete"] }).success).toBe(false);
    expect(roles.owner.authorize({ organization: ["delete"] }).success).toBe(true);
  });

  it("the app role and Data API roles hold no privilege on any auth table", async () => {
    for (const t of ["user", "session", "account", "verification", "organization", "member", "invitation"]) {
      for (const role of ["e2p_app", "anon", "authenticated"]) {
        const q = await db.pool.query("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, `public."${t}"`]);
        expect(q.rows[0].ok, `${role} on ${t}`).toBe(false);
      }
    }
  });

  it("refuses to start without BETTER_AUTH_SECRET", () => {
    expect(() => createAuth(db.pool, { secret: "" })).toThrow(/BETTER_AUTH_SECRET/);
  });
});

/** Headers carrying a real session for `userId` (sign-in in-process, no network). */
async function ownerHeaders(userId: string): Promise<Headers> {
  const email = (await db.pool.query("SELECT email FROM \"user\" WHERE id=$1", [userId])).rows[0].email as string;
  const res = await auth.api.signInEmail({ body: { email, password: "fictional-pass-123" }, asResponse: true });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie });
}
