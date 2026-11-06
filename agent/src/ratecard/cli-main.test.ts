import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadKernel, type KernelBridge } from "../kernel/index.js";
import { createTestDb, type TestDb } from "../ledger/test-db.js";
import { cardMain } from "./cli-main.js";
import { runDemo } from "./demo.js";
import { REPO_ROOT } from "./paths.js";

const TEMPLATE = "rate-cards/templates/fictional-banquet-template";
let db: TestDb;
let kernel: KernelBridge;
let scratch: string;

beforeAll(async () => {
  db = await createTestDb();
  kernel = await loadKernel();
  scratch = await mkdtemp(path.join(tmpdir(), "card-cli-"));
});
afterAll(async () => {
  await db.drop();
  await rm(scratch, { recursive: true, force: true });
});

describe("pnpm card compile", () => {
  it("prints the hash and exits 0 for a good template", async () => {
    const r = await cardMain(["compile", TEMPLATE]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/compile: OK fictional-banquet/);
    expect(r.out).toMatch(/card hash: [0-9a-f]{64}/);
  });

  it("prints the exact cell and exits 1 for a broken template", async () => {
    const dir = path.join(scratch, "broken");
    await cp(path.join(REPO_ROOT, TEMPLATE), dir, { recursive: true });
    const rules = await readFile(path.join(dir, "rules.csv"), "utf8");
    await writeFile(path.join(dir, "rules.csv"), rules.replace("1250", "12x50"));
    const r = await cardMain(["compile", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('rules.csv row 4, column "price": "12x50" is not an amount in INR');
  });

  it("exit 2 with usage when called wrongly", async () => {
    expect((await cardMain(["compile"])).code).toBe(2);
    expect((await cardMain(["compile", "no/such/dir"])).code).toBe(2);
  });
});

describe("pnpm card approve (simulated read-backs)", () => {
  const base = ["approve", TEMPLATE, "--tenant", "tenant-cli-venue"];

  it("needs exactly one of --yes / --no", async () => {
    expect((await cardMain(base, { pool: db.pool, kernel })).code).toBe(2);
    expect((await cardMain([...base, "--yes", "--no", "1"], { pool: db.pool, kernel })).code).toBe(2);
  });

  it("--no leaves the card a draft (exit 1) and says so", async () => {
    const r = await cardMain([...base, "--no", "2"], { pool: db.pool, kernel });
    expect(r.code).toBe(1);
    expect(r.out).toContain("NOT approved");
    const rows = await db.pool.query("SELECT status FROM rate_cards WHERE tenant_id='tenant-cli-venue'");
    expect(rows.rows).toEqual([{ status: "draft" }]);
  });

  it("--yes approves it (exit 0); doing it again is a no-op", async () => {
    const r = await cardMain([...base, "--yes"], { pool: db.pool, kernel });
    expect(r.code).toBe(0);
    expect(r.out).toContain("approved: revision 1 is now the active card");
    const again = await cardMain([...base, "--yes"], { pool: db.pool, kernel });
    expect(again.code).toBe(0);
    expect(again.out).toContain("already approved");
  });
});

describe("pnpm card demo", () => {
  it("tells the whole story: exact error, refusal before approval, no-then-yes, edit has no effect, re-approval changes the quote", async () => {
    const out = await runDemo(db.pool);
    expect(out).toContain('rules.csv row 4, column "price": "abc"');
    expect(out).toContain('"ruleGap":"card_not_approved"');
    expect(out).toContain("approved: false");
    expect(out).toContain("the reply is unchanged, still the approved price");
    expect(out).toContain("Total: ₹5,66,400");
    expect(out).toContain("Total: ₹5,78,200");
  });
});
