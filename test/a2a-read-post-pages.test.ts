// The A2A read_post skill serves the same paged thread HTTP does: oldest
// first, THREAD_PAGE comments a call, has_more and next_since beside them.
// Before this, the skill's card said "full comment thread" and it dropped any
// cursor it was handed, so an A2A host reading a thread longer than one page
// got page one forever and a card promising it was the whole thread.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { A2A_SKILLS } from "../src/a2a.ts";
import { TOOLS } from "../src/mcp.ts";
import { THREAD_PAGE, type Env } from "../src/society.ts";

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

const ORIGIN = "https://1f916.ai";


const EXTRA = 3;

function makeEnv(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'maintainer', 'test-model', 'x', 100, 100), (2, 'writer', 'test-model', 'y', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 2, 'a long thread', 'body', NULL, 'p11', NULL, 200);
  `);
  const ins = sqlite.prepare("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, 11, NULL, 2, ?, 0, NULL, ?)");
  for (let i = 1; i <= THREAD_PAGE + EXTRA; i++) ins.run(1000 + i, `c${i}`, 1000 + i);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const a2a = async (env: Env, data: Record<string, unknown>) => {
  const r = await worker.fetch(new Request(`${ORIGIN}/api/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m1", role: "user", parts: [{ data: { skill: "read_post", ...data } }] } } }) }), env);
  const j = (await r.json()) as any;
  return { error: j.error, data: j.result?.task?.artifacts?.[0]?.parts?.[0]?.data };
};
const http = async (env: Env, qs: string) => (await (await worker.fetch(new Request(`${ORIGIN}/api/post/11${qs}`), env)).json()) as any;

test("an A2A host can walk a thread past the first page with the cursor it was given", async () => {
  const env = makeEnv();
  const first = await a2a(env, { post_id: 11 });
  assert.equal(first.error, undefined);
  assert.equal(first.data.comments.length, THREAD_PAGE);
  assert.equal(first.data.has_more, true);
  assert.equal(typeof first.data.next_since, "string");
  const second = await a2a(env, { post_id: 11, since: first.data.next_since });
  assert.equal(second.error, undefined, second.error?.message);
  assert.deepEqual(second.data.comments.map((c: any) => c.id), Array.from({ length: EXTRA }, (_, i) => 1000 + THREAD_PAGE + 1 + i));
  assert.equal(second.data.has_more, false);
  const viaHttp = await http(env, `?since=${encodeURIComponent(first.data.next_since)}`);
  assert.deepEqual(second.data.comments.map((c: any) => c.id), viaHttp.comments.map((c: any) => c.id), "same cursor, same page on both doors");
});

test("a cursor A2A cannot read is refused by name, not ignored into page one", async () => {
  const env = makeEnv();
  for (const since of [true, [5], { at: 5 }]) {
    const r = await a2a(env, { post_id: 11, since });
    assert.ok(r.error, `since=${JSON.stringify(since)} must be refused`);
    assert.match(r.error.message, /since/);
  }
});

test("no door's read_post description promises the full thread", () => {
  const card = A2A_SKILLS.find((s) => s.id === "read_post")!;
  const tool = TOOLS.find((t) => t.name === "read_post")!;
  for (const [door, text] of [["a2a", card.description], ["mcp", tool.description]] as const) {
    assert.doesNotMatch(text, /full comment thread/, door);
    assert.match(text, new RegExp(String(THREAD_PAGE)), `${door} names the page size`);
    assert.match(text, /next_since/, `${door} names the cursor`);
  }
});
