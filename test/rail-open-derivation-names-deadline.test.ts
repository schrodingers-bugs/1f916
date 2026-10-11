// GET /api/rail's derivations.open must not promise that every open row takes
// work, now that the same row serves submission_deadline.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// WQ-325 put submission_deadline on every rail listing row, beside `open`. The
// served derivation for `open` still said "Only these can take new submissions
// or make new awards", so a reader following the page's own rule would submit
// to an open row whose submission_deadline had passed and get a 409 from
// POST /api/listings/:id/submissions ("stopped taking work at its declared
// submission_deadline"). The derivation now names both clocks and the exact
// predicate for "takes new submissions"; this test applies that predicate to
// the served rows.
//
// KILLING MUTATION: restore the old sentence ("Only these can take new
// submissions or make new awards.") in railCensus derivations.open
// (src/society.ts). Both tests go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { railCensus, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  const future = nowS + 3600 * 24 * 30;
  const deadline = nowS - 3600; // a stop-work clock that has already passed
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'funder', 'test-model', 'x', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, submission_deadline, payload_hash, commit_nonce, created_at)
    VALUES
      (1, 1, 'deadline past, still open', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, ${deadline}, 'ph-1', 'nonce-1', 200),
      (2, 1, 'no deadline set',           '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, NULL,      'ph-2', 'nonce-2', 210);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}


test("derivations.open does not claim every open rail row takes submissions", async () => {
  const env = await makeEnv();
  const census = (await railCensus(env)) as Record<string, any>;
  const open = String(census.derivations.open);
  assert.doesNotMatch(open, /Only these can take new submissions/, "an open row past its submission_deadline refuses work, so open alone is not the rule");
  assert.match(open, /submission_deadline/, "the derivation names the stop-work clock served on the same row");
  assert.match(open, /submission_deadline === null \|\| submission_deadline \* 1000 > now/, "and states the predicate in the page's own units");
});

test("the served predicate splits the fixture rows the way the submit route does", async () => {
  const env = await makeEnv();
  const census = (await railCensus(env)) as Record<string, any>;
  assert.match(String(census.derivations.open), /submission_deadline \* 1000 > now/);
  const now = Number(census.now);
  const takes = (r: Record<string, any>) => r.open === true && (r.submission_deadline === null || r.submission_deadline * 1000 > now);
  const rows = census.listings as Array<Record<string, any>>;
  const past = rows.find((r) => r.listing_id === 1)!;
  const none = rows.find((r) => r.listing_id === 2)!;
  assert.equal(past.open, true, "listing 1 is open");
  assert.equal(takes(past), false, "but past its submission_deadline, so it takes no work (the submit route answers 409)");
  assert.equal(takes(none), true, "listing 2 declares no deadline, so open means taking work");
});
