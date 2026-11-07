/** T17 owner channel, the ticket's demo: a simulated WhatsApp thread driven through runFixture. All data FICTIONAL. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { collectingNotifier, type EscalationEvent } from "../escalation/index.js";
import { loadKernel } from "../kernel/index.js";
import { verifyLedger } from "../ledger/index.js";
import { runFixture, type OwnerLine, type RunResult } from "../simulator/run-fixture.js";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.drop();
});

const T = "tenant-owner-demo";

describe("the owner demo, driven through the simulator (fixtures/owner-01.json)", () => {
  let run: RunResult;
  const events: EscalationEvent[] = [];
  beforeAll(async () => {
    run = await runFixture("fixtures/owner-01.json", { pool: db.pool, notifier: collectingNotifier(events) });
  });
  const lines = (): OwnerLine[] => run.ownerTranscript ?? [];
  const replies = () => lines().filter((l): l is Extract<OwnerLine, { dir: "to_owner" }> => l.dir === "to_owner" && l.kind === "reply");
  const ledger = async (sql: string, args: unknown[] = []) => (await db.pool.query(sql, [T, ...args])).rows;

  const stateOf = async (id: string) => ((await db.pool.query("SELECT state FROM threads WHERE id=$1", [id])).rows[0] as { state: string }).state;

  it("a refusal is escalated to the owner and the manager (not staff) with the quick replies", () => {
    const first = lines().filter((l) => l.dir === "to_owner" && l.kind === "escalation").slice(0, 2);
    expect(first.map((l) => (l.dir === "to_owner" ? l.to : ""))).toEqual(["owner", "manager"]);
    const text = first[0]!.text;
    expect(text).toMatch(/^\[R\d+\] FICTIONAL: Marigold Hall: a customer enquiry needs you\./);
    expect(text).toContain("quote ₹__ / decline / call them");
    expect(text).toContain("They asked: banquet, 13 Jun 2027, 300 guests");
    expect(text).toContain("Why: No rate-card rule covers this enquiry");
    expect(text).not.toMatch(/\+91|\d{10}/); // never a phone number
  });

  it("'why' is answered from the refusal's ledger row: reason code, rule gap, what they asked, status, hash", async () => {
    const why = replies()[0]!.text;
    const row = (await ledger("SELECT tenant_seq::int AS n, hash, payload FROM ledger_entries WHERE tenant_id=$1 AND type='refusal' ORDER BY tenant_seq LIMIT 1"))[0];
    expect(why).toContain(`R${row.n}: the agent did not quote this enquiry.`);
    expect(why).toContain("Reason: No rate-card rule covers this enquiry (no_covering_rule).");
    expect(why).toContain(`Rule gap: ${row.payload.ruleGap}.`);
    expect(why).toContain("They asked: banquet, 13 Jun 2027, 300 guests");
    expect(why).toContain("Status: waiting for you.");
    expect(why).toContain(`hash ${row.hash.slice(0, 12)}.`);
  });

  it("staff cannot set a price: told no, nothing sent to the customer, nothing priced, denial logged", async () => {
    expect(replies()[1]!.text).toBe("Sorry, only the owner or a manager can do that. You can ask me for the digest or say why R12.");
    const denied = await ledger("SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND type='owner_message' AND payload->>'denied'='true'");
    expect(denied).toHaveLength(1);
    expect(denied[0].payload).toMatchObject({ command: "quote", role: "staff", text: "quote Rs 85,000" });
  });

  it("the owner's 'quote Rs 85,000' prices the only waiting enquiry: owner_quote flagged owner-priced, templated customer message, no agent quote", async () => {
    expect(replies()[2]!.text).toMatch(/^Done\. Sent the customer your price of ₹85,000 for R\d+\./);
    const oq = await ledger("SELECT thread_id, payload, rate_card_hash FROM ledger_entries WHERE tenant_id=$1 AND type='owner_quote'");
    expect(oq).toHaveLength(1);
    expect(oq[0].payload).toMatchObject({ ownerPriced: true, total: 8_500_000, currency: "INR", role: "owner" });
    expect(oq[0].rate_card_hash).toBeNull();
    const agentQuotes = await ledger("SELECT 1 FROM ledger_entries WHERE tenant_id=$1 AND type='quote' AND thread_id=$2", [oq[0].thread_id]);
    expect(agentQuotes).toHaveLength(0);
    const sent = lines().filter((l) => l.dir === "to_customer");
    expect(sent[0]).toMatchObject({ threadId: oq[0].thread_id });
    expect(sent[0]!.dir === "to_customer" && sent[0]!.text).toBe(
      "Thank you for your enquiry with FICTIONAL: Marigold Hall.\n\nWe have looked at your request personally and can offer:\n\nTotal: ₹85,000\n\nReply here to confirm and we will take it forward.",
    );
    expect(await stateOf(oq[0].thread_id)).toBe("quoted");
  });

  it("'decline' sends the templated polite message (the manager may) and closes the thread", async () => {
    const sent = lines().filter((l): l is Extract<OwnerLine, { dir: "to_customer" }> => l.dir === "to_customer");
    expect(sent[1]!.text).toBe(
      "Thank you for thinking of FICTIONAL: Marigold Hall. We have looked at your request and, sadly, we are not able to take it on this time. We wish you all the best with your plans.",
    );
    expect(await stateOf(sent[1]!.threadId)).toBe("closed");
    const d = await ledger("SELECT payload FROM ledger_entries WHERE tenant_id=$1 AND type='owner_message' AND payload->>'command'='decline'");
    expect(d[0].payload).toMatchObject({ role: "manager" });
  });

  it("'call them' leaves a follow-up marker, sends the customer nothing, and keeps the thread open", async () => {
    expect(sent().length).toBe(2);
    const m = await ledger("SELECT thread_id, payload FROM ledger_entries WHERE tenant_id=$1 AND type='owner_message' AND payload->>'command'='call_them'");
    expect(m[0].payload).toMatchObject({ followUp: true });
    expect(await stateOf(m[0].thread_id)).toBe("refused");
    function sent() {
      return lines().filter((l) => l.dir === "to_customer");
    }
  });

  it("the daily digest is built from the ledger with exact numbers", () => {
    const d = lines().filter((l) => l.dir === "to_owner" && l.kind === "digest");
    expect(d.map((l) => (l.dir === "to_owner" ? l.to : ""))).toEqual(["owner", "manager"]);
    expect(d[0]!.dir === "to_owner" && d[0]!.text).toBe(
      [
        "Daily summary for FICTIONAL: Marigold Hall",
        "Last 24 hours:",
        "- New enquiries: 3",
        "- Quotes sent by the agent: 0",
        "- Prices set by you or a manager: 1",
        "- Refusals: 3",
        "- Collected: nothing yet",
        "Waiting for you: nothing.",
        "Call-backs marked: 1",
      ].join("\n"),
    );
  });

  it("every ledger chain still verifies, and the new kind is part of it", async () => {
    const v = await verifyLedger(db.pool, await loadKernel(), { tenantId: T });
    expect(v.ok).toBe(true);
  });
});
