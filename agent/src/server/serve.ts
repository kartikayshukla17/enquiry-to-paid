import { randomBytes } from "node:crypto";
import pg from "pg";
import { loadKernel } from "../kernel/index.js";
import { DEFAULT_DATABASE_URL } from "../ledger/test-db.js";
import { migrate } from "../ledger/migrate.js";
import type { ProviderRegistry } from "../payments/registry.js";
import { razorpayLive } from "../payments/razorpay-live.js";
import { razorpaySecretFromEnv, razorpaySim } from "../payments/razorpay-sim.js";
import { stripeLive } from "../payments/stripe-live.js";
import { stripePaymentLinksSim, stripeSecretFromEnv } from "../payments/stripe-sim.js";
import { createAppServer } from "./app.js";

// Demo convenience only (same as `pnpm sim`): throwaway process-local keys when none are configured.
for (const name of ["PII_ENC_KEY", "PHONE_HASH_KEY"]) {
  if (!process.env[name]) process.env[name] = randomBytes(32).toString("base64");
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL });
await migrate(pool);
const kernel = await loadKernel();

// Providers: simulators always; the real adapters only when their credentials are present (test keys in development,
// live keys in a real deployment).
const providers: ProviderRegistry = {
  "razorpay-sim": razorpaySim({ webhookSecret: razorpaySecretFromEnv() }),
  "stripe-sim": stripePaymentLinksSim({ webhookSecret: stripeSecretFromEnv() }),
};
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET) {
  providers.razorpay = razorpayLive({ keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET });
}
if (process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
  providers.stripe = stripeLive({ secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET });
}
const defaultProvider = process.env.PAYMENTS_PROVIDER && providers[process.env.PAYMENTS_PROVIDER] ? process.env.PAYMENTS_PROVIDER : providers.razorpay ? "razorpay" : "razorpay-sim";

const server = createAppServer({ pool, kernel, providers, defaultProvider, visitorIpKey: process.env.PHONE_HASH_KEY! });

// Render (and most PaaS hosts) inject PORT and require binding all interfaces, not just localhost.
const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? 4010);
server.listen(port, "0.0.0.0", () => {
  const google = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? "on" : "off";
  console.error(
    `agent server on :${port} (LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "fixture"}, LLM_MODE=${process.env.LLM_MODE ?? "replay"}, payments=${defaultProvider}, google=${google})`,
  );
});
