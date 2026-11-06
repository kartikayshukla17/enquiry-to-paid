import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { withTenant } from "../tenancy/with-tenant.js";
import { decryptPii, encryptPii, phoneHash, piiKeysFromEnv, type PiiKeys } from "./pii.js";

const keys = (): PiiKeys => ({ encKey: randomBytes(32), hashKey: randomBytes(32) });
const PHONE = "+910000000001"; // fictional

describe("pii crypto", () => {
  it("encrypts to non-plaintext, round-trips, and uses a fresh nonce each time", () => {
    const k = keys();
    const a = encryptPii(k, PHONE);
    const b = encryptPii(k, PHONE);
    expect(a).not.toContain(PHONE);
    expect(a).not.toBe(b);
    expect(decryptPii(k, a)).toBe(PHONE);
  });

  it("rejects tampered ciphertext and a wrong key", () => {
    const k = keys();
    const ct = encryptPii(k, PHONE);
    const parts = ct.split(".");
    parts[2] = Buffer.from("tampered").toString("base64");
    expect(() => decryptPii(k, parts.join("."))).toThrow();
    expect(() => decryptPii(keys(), ct)).toThrow();
  });

  it("phoneHash is a stable HMAC that depends on the key and on normalisation", () => {
    const k = keys();
    expect(phoneHash(k, PHONE)).toBe(phoneHash(k, " +91 00000 00001 "));
    expect(phoneHash(k, PHONE)).not.toBe(phoneHash(keys(), PHONE));
    expect(phoneHash(k, PHONE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loads keys from env and refuses missing or wrong-length keys", () => {
    expect(piiKeysFromEnv().encKey).toHaveLength(32);
    expect(() => piiKeysFromEnv({})).toThrow(/PII_ENC_KEY/);
    expect(() => piiKeysFromEnv({ PII_ENC_KEY: "c2hvcnQ=", PHONE_HASH_KEY: "c2hvcnQ=" })).toThrow(/32/);
  });
});

describe("pii at rest", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.drop();
  });

  it("customer and member phones are stored encrypted, found by hash, and decrypt back", async () => {
    const k = keys();
    await db.pool.query("INSERT INTO tenants (id, name) VALUES ('t','t')");
    await withTenant(db.pool, "t", async (c) => {
      await c.query("INSERT INTO customers (id, tenant_id, phone_hash, phone_enc) VALUES ('c','t',$1,$2)", [phoneHash(k, PHONE), encryptPii(k, PHONE)]);
      await c.query("INSERT INTO members (id, tenant_id, role, phone_hash, phone_enc) VALUES ('m','t','staff',$1,$2)", [phoneHash(k, PHONE), encryptPii(k, PHONE)]);
    });
    const raw = await db.pool.query("SELECT phone_enc FROM customers UNION ALL SELECT phone_enc FROM members");
    for (const r of raw.rows) expect(r.phone_enc).not.toContain("0000000001");
    const found = await withTenant(db.pool, "t", (c) => c.query("SELECT phone_enc FROM customers WHERE phone_hash=$1", [phoneHash(k, "+91 00000 00001")]));
    expect(decryptPii(k, found.rows[0].phone_enc)).toBe(PHONE);
    const member = await withTenant(db.pool, "t", (c) => c.query("SELECT role FROM members WHERE phone_hash=$1", [phoneHash(k, PHONE)]));
    expect(member.rows[0].role).toBe("staff");
  });

  it("members reject roles outside owner/manager/staff", async () => {
    await db.pool.query("INSERT INTO tenants (id, name) VALUES ('t2','t2')");
    await expect(db.pool.query("INSERT INTO members (id, tenant_id, role) VALUES ('x','t2','admin')")).rejects.toThrow();
  });
});
