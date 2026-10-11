// schemas/rail.json now describes GET /api/rail's listings[] rows and its
// derivations object.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// The rail schema listed observer, totals, liability_by_asset, demand and
// funders, but not listings or derivations, and it sets additionalProperties
// true. So the per-listing rows a reader actually uses to decide where to
// submit (open, expiry, submission_deadline, asset) had no contract: WQ-325
// added submission_deadline to every row and no schema could have caught it
// being dropped again, or served as a string, or served in milliseconds next
// to an expiry in seconds. This test runs railCensus on a two-listing fixture,
// validates the whole response against the published schema, and then breaks
// one row field at a time to prove the schema refuses each break.
//
// KILLING MUTATIONS:
//   1. Remove "listings" from the top-level required list: a response with
//      no listings validates and test 2 goes red.
//   2. Remove "submission_deadline" from the row's required list: a row
//      without it validates and test 3 goes red.
//   3. Widen submission_deadline's type to include "string": test 3 goes red.
//   4. Drop submission_deadline from the row built in railCensus
//      (src/society.ts): test 1 goes red.

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

import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/rail.json", import.meta.url)), "utf8"));

const served = async () => JSON.parse(JSON.stringify(await railCensus(await makeEnv()))) as Record<string, any>;

test("the served /api/rail census validates against schemas/rail.json, listings and derivations included", async () => {
  const body = await served();
  assert.equal(body.listings.length, 2);
  assert.deepEqual(validate(schema, body), []);
  assert.equal(body.listings[1].submission_deadline, null, "the null branch of the type is exercised");
  assert.equal(typeof body.listings[0].submission_deadline, "number", "and so is the integer branch");
});

test("a response with no listings or no derivations is refused", async () => {
  const noListings = await served();
  delete noListings.listings;
  assert.ok(validate(schema, noListings).some((e) => /listings/.test(e)));
  const noDerivations = await served();
  delete noDerivations.derivations;
  assert.ok(validate(schema, noDerivations).some((e) => /derivations/.test(e)));
  const noOpenRule = await served();
  delete noOpenRule.derivations.open;
  assert.ok(validate(schema, noOpenRule).some((e) => /open/.test(e)), "derivations.open is the rule rows are read by");
});

test("each row break a reader would act on is refused by name", async () => {
  const breaks: Array<[string, (r: Record<string, any>) => void]> = [
    ["submission_deadline", (r) => { delete r.submission_deadline; }],
    ["submission_deadline", (r) => { r.submission_deadline = String(r.submission_deadline); }],
    ["open", (r) => { r.open = 1; }],
    ["expiry", (r) => { r.expiry = new Date(r.expiry * 1000).toISOString(); }],
    ["asset", (r) => { delete r.asset.token; }],
    ["listing_id", (r) => { r.listing_id = 0; }],
    ["liability_scope", (r) => { r.liability_scope = "v3_ledger"; }],
  ];
  for (const [field, breakIt] of breaks) {
    const body = await served();
    breakIt(body.listings[0]);
    const errors = validate(schema, body);
    assert.ok(errors.some((e) => e.includes(field)), `breaking ${field} must fail validation, got ${JSON.stringify(errors)}`);
  }
});
