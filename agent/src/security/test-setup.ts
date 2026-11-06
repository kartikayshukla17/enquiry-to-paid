import { randomBytes } from "node:crypto";

// Throwaway per-run keys: nothing here is a secret and nothing is committed.
process.env.PII_ENC_KEY ??= randomBytes(32).toString("base64");
process.env.PHONE_HASH_KEY ??= randomBytes(32).toString("base64");
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("base64");
