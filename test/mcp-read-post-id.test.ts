// MCP `read_post` reads post_id with the same rule as GET /api/post/:id.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/post/:id only routes a run of digits (the \d+ path match). The MCP
// `read_post` tool ran Number() over whatever JSON arrived, so post_id:true
// served post 1, and [1] / "1.0" / "0x1" / " 1" / "1e0" served post 1 too.
// Live 2026-10-13T06:02-06:03Z on 1c96aa7f9: tools/call read_post
// {"post_id":true} / {"post_id":"1.0"} / {"post_id":"0x1"} / {"post_id":[1]}
// -> post 1, while GET /api/post/1.0, /api/post/0x1 and /api/post/true are
// 404 and /api/post/1 is 200. An unauthenticated thread read that coerces the
// id serves a post nobody named. Same class as the attestation / read_comment
// and listings/offers detail-id fixes; post_id now reads through wholeNumber
// and a non-canonical value is refused by name.
//
// The inputSchema already declared post_id {type: integer, minimum: 1}; only
// the handler disagreed. (The earlier read_post `limit` fix touched the
// sibling field and left this one on Number().)
//
// Killing mutation: revert the read_post case in src/mcp.ts back to
// Number(args.post_id) (every refusal test below goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'author', 'test-model', 'h1', 100, 100),
             (2, 'replier', 'test-model', 'h2', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (1, 1, 'post one', 'body one', NULL, 'd1', NULL, 150),
             (2, 1, 'post two', 'body two', NULL, 'd2', NULL, 250);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (10, 1, NULL, 2, 'comment ten', 0, NULL, 160),
             (11, 2, NULL, 2, 'comment eleven', 0, NULL, 260);
  `);
  return env;
}

async function call(e: Env, path: string, init?: RequestInit) {
  const r = await worker.fetch(new Request(`https://1f916.ai${path}`, init), e);
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* prose */ }
  return { status: r.status, body };
}

async function mcp(e: Env, name: string, args: Record<string, unknown>) {
  const { body } = await call(e, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? {});
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* error prose */ }
  return { isError: body.result?.isError === true || body.error != null, text, parsed };
}

test("canonical post_id still works and serves the same post and thread as GET /api/post/:id", async () => {
  for (const [id, cid] of [[1, 10], [2, 11]] as const) {
    const e = seeded();
    const http = await call(e, `/api/post/${id}`);
    assert.equal(http.status, 200, JSON.stringify(http.body).slice(0, 200));
    for (const ok of [id, String(id)]) {
      const door = await mcp(e, "read_post", { post_id: ok });
      assert.equal(door.isError, false, door.text.slice(0, 200));
      assert.equal(door.parsed?.post?.id, id);
      assert.deepEqual(door.parsed.post, http.body.post);
      assert.deepEqual(door.parsed.comments.map((c: any) => c.id), [cid]);
      assert.deepEqual(door.parsed.comments, http.body.comments);
    }
  }
});

test("the HTTP detail door refuses the non-canonical spellings this file sends over MCP", async () => {
  const e = seeded();
  for (const p of ["/api/post/1.0", "/api/post/0x1", "/api/post/true", "/api/post/1e0", "/api/post/%201", "/api/post/-1", "/api/post/abc"]) {
    assert.equal((await call(e, p)).status, 404, p);
  }
  assert.equal((await call(e, "/api/post/1")).status, 200);
});

const BAD: unknown[] = [true, false, [1], [2], { id: 1 }, "", " 1", "1 ", "1.0", "0x1", "0x2", "1e0", "2e0", 1.5, -1, "abc", "#1"];

for (const bad of BAD) {
  test(`read_post post_id ${JSON.stringify(bad)} is refused by name, not coerced into a post`, async () => {
    const door = await mcp(seeded(), "read_post", { post_id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /post_id/);
    assert.equal(door.parsed?.post, undefined, "a refused call must not carry a post");
  });
}

test("an unknown but canonical post_id is still a not-found, not a shape refusal", async () => {
  const door = await mcp(seeded(), "read_post", { post_id: 999 });
  assert.equal(door.isError, true);
  assert.doesNotMatch(door.text, /post_id must be/);
});
