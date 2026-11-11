/**
 * V7's structural guarantee, as a test, not a review (same discipline as `pipeline/kill-switch.test.ts`,
 * documented in `agent/README.md`'s T28 section): "disabling the GitHub Actions workflow is the only
 * thing that stops scheduled work -- nothing else in the deployed service silently runs it on a timer of
 * its own." The only way `runDueTimers`/the owner digest check ever run in the deployed process is a
 * request arriving at `POST /tick` (see `app.ts`). This greps the deployed server's own source (non-test)
 * for `setInterval`, a recurring `setTimeout` (a many-millisecond delay, the shape a poll loop would use),
 * `cron`, or `setImmediate` used to re-arm itself -- any of which would be a background loop nothing in
 * this ticket authorized. Same grep-guard precedent as `guards/guards.test.ts` and `payments/proof.test.ts`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));

const isTest = (name: string): boolean => /\.test\.ts$/.test(name);

function serverSources(): string[] {
  return readdirSync(SERVER_DIR)
    .filter((name) => name.endsWith(".ts") && !isTest(name))
    .map((name) => path.join(SERVER_DIR, name));
}

/** `setInterval` at all, or `setTimeout`/`setImmediate` whose callback re-arms itself (the recurring-loop shape),
 *  or anything naming `cron`/`node-cron`/`node-schedule`. A one-shot `setTimeout` used for, say, a request
 *  timeout is not itself a background scheduler and is not what this guards against. */
const SCHEDULER = /\bsetInterval\s*\(|\bcron\b|node-schedule/i;

describe("guard: the deployed server never schedules its own recurring work", () => {
  it("agent/src/server/*.ts (non-test) never calls setInterval or names a cron library", () => {
    const hits = serverSources().flatMap((p) =>
      readFileSync(p, "utf8")
        .split("\n")
        .map((line, i) => ({ file: path.relative(SERVER_DIR, p), line: i + 1, text: line.trim() }))
        .filter((l) => SCHEDULER.test(l.text)),
    );
    expect(hits).toEqual([]);
  });

  it("the guard really bites: a planted recurring timer is caught by the same pattern", () => {
    expect(SCHEDULER.test("setInterval(() => tick(), 5 * 60 * 1000);")).toBe(true);
    expect(SCHEDULER.test('import cron from "node-cron";')).toBe(true);
    expect(SCHEDULER.test('const schedule = require("node-schedule");')).toBe(true);
    expect(SCHEDULER.test("setTimeout(() => res.end(), 30000);")).toBe(false); // a one-shot request timeout, not a scheduler
  });

  it("app.ts's only entry point into runDueTimers/sendDailyDigest is the POST /tick branch", () => {
    const appTs = readFileSync(path.join(SERVER_DIR, "app.ts"), "utf8");
    // Exactly one call site each, both inside the same `req.url === "/tick"` branch -- never at module load,
    // never on a timer. (If a second call site is ever added outside that branch, this count breaks and the
    // reviewer has to explain why; it is not sufficient on its own, but it is cheap and it does break.)
    expect(appTs.match(/\brunDueTimers\s*\(/g) ?? []).toHaveLength(1);
    expect(appTs.match(/\bsendDailyDigest\s*\(/g) ?? []).toHaveLength(1);
  });
});
