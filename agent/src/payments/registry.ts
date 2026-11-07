/** Per-tenant payment provider selection (T16): a registry of available providers by name, and the tenant's configured name. */
import type { Pool, PoolClient } from "pg";
import { withTenant } from "../tenancy/with-tenant.js";
import type { PaymentProvider } from "./types.js";

export type ProviderRegistry = Record<string, PaymentProvider>;

export async function getTenantPaymentProvider(client: PoolClient, tenantId: string): Promise<string | undefined> {
  return (await client.query<{ provider: string }>("SELECT provider FROM tenant_payment_config WHERE tenant_id=$1", [tenantId])).rows[0]?.provider;
}

/** Inside the tenant's transaction: the provider to use for NEW links, or undefined (not configured / not available). */
export async function providerForTenant(client: PoolClient, tenantId: string, registry: ProviderRegistry): Promise<PaymentProvider | undefined> {
  const name = await getTenantPaymentProvider(client, tenantId);
  return name !== undefined && Object.hasOwn(registry, name) ? registry[name] : undefined;
}

/** Owner/operator setting. Only names the DB check allows are stored; affects new links only. */
export async function setTenantPaymentProvider(pool: Pool, tenantId: string, provider: string): Promise<void> {
  await withTenant(pool, tenantId, (c) =>
    c.query(
      `INSERT INTO tenant_payment_config (tenant_id, provider, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (tenant_id) DO UPDATE SET provider = EXCLUDED.provider, updated_at = EXCLUDED.updated_at`,
      [tenantId, provider],
    ),
  );
}
