import type { Pool } from "pg";
import { encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "../security/pii.js";
import { withTenant } from "../tenancy/with-tenant.js";
import type { MemberRole } from "./types.js";

/**
 * Seeds members with a hashed phone (and ciphertext), the way a real onboarding would after the Better Auth
 * organization is created. Simulator and tests only; ids are deterministic (`<tenant>:member:<role>:<n>`).
 */
export async function seedOwnerMembers(pool: Pool, tenantId: string, members: { role: MemberRole; phone: string }[], pii: PiiKeys = piiKeysFromEnv()): Promise<string[]> {
  return withTenant(pool, tenantId, async (c) => {
    const ids: string[] = [];
    let n = 0;
    for (const m of members) {
      n += 1;
      const id = `${tenantId}:member:${m.role}:${n}`;
      await c.query(
        "INSERT INTO members (id, tenant_id, role, phone_hash, phone_enc) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING",
        [id, tenantId, m.role, phoneHash(pii, m.phone), encryptPii(pii, m.phone)],
      );
      ids.push(id);
    }
    return ids;
  });
}
