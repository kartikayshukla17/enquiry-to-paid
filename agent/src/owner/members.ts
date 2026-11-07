import type { PoolClient } from "pg";
import { phoneHash, type PiiKeys } from "../security/pii.js";
import type { MemberRole } from "./types.js";

export interface Member {
  id: string;
  role: MemberRole;
}

/** Hashed-phone lookup (as T5 and the block commands): the phone itself is never stored or compared in clear. */
export async function findMemberByPhone(client: PoolClient, tenantId: string, pii: PiiKeys, senderRef: string): Promise<Member | undefined> {
  return (
    await client.query<Member>("SELECT id, role FROM members WHERE tenant_id=$1 AND phone_hash=$2", [tenantId, phoneHash(pii, senderRef)])
  ).rows[0];
}

/** Owners then managers: who is told about escalations and gets the daily digest. Staff are read-only and not pushed to. */
export async function pushRecipients(client: PoolClient, tenantId: string): Promise<Member[]> {
  return (
    await client.query<Member>(
      `SELECT id, role FROM members WHERE tenant_id=$1 AND role IN ('owner','manager') AND phone_hash IS NOT NULL
        ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, id`,
      [tenantId],
    )
  ).rows;
}
