import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

/**
 * PII protection for phone numbers.
 * - `encryptPii`: AES-256-GCM, random 96-bit nonce per value, key from env `PII_ENC_KEY`.
 * - `phoneHash`: HMAC-SHA256 over the normalised number, key from env `PHONE_HASH_KEY`; the only way to look a phone up.
 * Keys are 32 random bytes, base64 in the environment. They are never committed and never logged.
 */
export interface PiiKeys {
  encKey: Buffer;
  hashKey: Buffer;
}

function key(env: Record<string, string | undefined>, name: string): Buffer {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set (expected 32 random bytes, base64; e.g. openssl rand -base64 32)`);
  const buf = Buffer.from(v, "base64");
  if (buf.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return buf;
}

export function piiKeysFromEnv(env: Record<string, string | undefined> = process.env): PiiKeys {
  return { encKey: key(env, "PII_ENC_KEY"), hashKey: key(env, "PHONE_HASH_KEY") };
}

/** Output format: `v1.<nonce>.<ciphertext>.<tag>`, each base64. */
export function encryptPii(keys: PiiKeys, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.encKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(".");
}

export function decryptPii(keys: PiiKeys, stored: string): string {
  const [v, iv, ct, tag] = stored.split(".");
  if (v !== "v1" || !iv || ct === undefined || !tag) throw new Error("unrecognised PII ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", keys.encKey, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** Whitespace is dropped so "+91 00000 00001" and "+910000000001" find the same row. */
export const normalisePhone = (phone: string) => phone.replace(/\s+/g, "");

export function phoneHash(keys: PiiKeys, phone: string): string {
  return createHmac("sha256", keys.hashKey).update(normalisePhone(phone)).digest("hex");
}
