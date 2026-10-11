// Second read of WQ-329 (03a3a7a14). The new amends_note clause makes a
// behavioural claim and gives consumers a recipe: amending re-serves no row for
// the original on /api/changes, so an incremental consumer must read `amends`
// on each new row and back-patch amended_by onto the comment it names. The
// upstream test only regex-matches the sentence. This file runs the recipe:
// sync page one, write the amenders, follow the served continuation in BOTH
// cursor modes, invert `amends`, and require the result to equal what a fresh
// full walk serves as amended_by. Fixture covers the cases a one-link fixture
// cannot: one amender naming two originals (amends_json), and a WITHDRAWN
// amender (amended_by includes withdrawn amenders by design, so the stream
// must still carry that row and its amends, or the recipe under-counts).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...(this.args as never[])).changes) } }; }
}

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (11, 1, 'a post', 'body', NULL, 'p11', NULL, 200, NULL);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, amends)
    VALUES (21, 11, NULL, 1, 'first original', 0, NULL, 210, NULL),
           (23, 11, NULL, 1, 'second original', 0, NULL, 230, NULL);
  `);
  const env = { DB: { prepare: (sql: string) => new Statement(sqlite, sql) } } as unknown as Env;
  return { sqlite, env };
}

// Written AFTER page one was synced: 24 amends both originals, 25 amends 21
// and was later withdrawn by its author.
function amend(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, amends, amends_json)
    VALUES (24, 11, NULL, 1, 'corrects both', 0, NULL, 310, 21, '[21,23]'),
           (25, 11, NULL, 1, 'second fix', 0, NULL, 320, 21, '[21]');
    UPDATE comments SET mod_state = 'withdrawn' WHERE id = 25;
  `);
}

async function at<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return await fn(); } finally { Date.now = realNow; }
}

type Row = { id: number; amends: number[]; amended_by: number[] };

function invert(store: Map<number, Row>) {
  const patched = new Map<number, number[]>();
  for (const id of store.keys()) patched.set(id, []);
  for (const row of [...store.values()].sort((a, b) => a.id - b.id)) {
    for (const target of row.amends) patched.get(target)?.push(row.id);
  }
  return patched;
}

async function incrementalSync(mode: "legacy" | "id") {
  const { sqlite, env } = seed();
  const store = new Map<number, Row>();
  const first = await at(300, () => (mode === "id" ? changes(env, 0, "0", "0") : changes(env, 170)));
  for (const c of first.comments as Row[]) store.set(c.id, c);
  assert.deepEqual([...store.keys()], [21, 23], "page one delivers both originals");
  assert.equal(first.has_more, false);

  amend(sqlite);
  const second = await at(400, () =>
    mode === "id"
      ? changes(env, 0, first.next_posts_since as string, first.next_comments_since as string)
      : changes(env, first.next_since as number),
  );
  const secondIds = (second.comments as Row[]).map((c) => c.id);
  assert.deepEqual(secondIds, [24, 25], `${mode}: the continuation carries exactly the amenders, withdrawn one included`);
  for (const c of second.comments as Row[]) store.set(c.id, c);

  // The hazard the note discloses is real: stored-as-served originals stay un-amended.
  assert.deepEqual(store.get(21)!.amended_by, [], `${mode}: no row re-served 21, so its stored amended_by is stale`);
  assert.deepEqual(store.get(23)!.amended_by, [], `${mode}: no row re-served 23, so its stored amended_by is stale`);

  const full = await at(400, () => changes(env, 0));
  const truth = new Map((full.comments as Row[]).map((c) => [c.id, c.amended_by]));
  return { patched: invert(store), truth };
}

for (const mode of ["legacy", "id"] as const) {
  test(`${mode} cursor: back-patching amends from the increment reproduces a full walk's amended_by`, async () => {
    const { patched, truth } = await incrementalSync(mode);
    assert.deepEqual(truth.get(21), [24, 25], "full walk: 21 is amended by 24 and the withdrawn 25, in id order");
    assert.deepEqual(truth.get(23), [24], "full walk: a multi-target amender lands on every original it names");
    for (const id of [21, 23, 24, 25]) {
      assert.deepEqual(patched.get(id), truth.get(id), `${mode}: back-patched amended_by of ${id} equals the served value`);
    }
  });
}
