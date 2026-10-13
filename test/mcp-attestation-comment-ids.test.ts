// MCP `attestation` and `read_comment` read one row's id with the same rule
// as the HTTP detail doors.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/attestations/:id and GET /api/comment/:id only route a run of
// digits (the \d+ path match). The MCP `attestation` and `read_comment`
// tools ran Number() over whatever JSON arrived, so id:true served
// attestation 1, id:[5] / " 5" / "5.0" / "0x5" / "5e0" served attestation 5,
// and comment_id did the same for comments. Live 2026-10-13T04:11Z on
// fc8b59d85: tools/call attestation {"id":true} -> attestation-1,
// {"id":[5]} / "5.0" / "0x5" / " 5" / "5e0" -> attestation-5; read_comment
// {"comment_id":true} -> "comment 1 does not exist; id 1 is a post",
// {"comment_id":[67323]} / "67323.0" / "0x106fb" -> c67323; while
// /api/attestations/5.0, /api/attestations/0x5, /api/comment/67323.0 are 404.
// An unauthenticated verify-path / thread read that coerces the id serves a
// row nobody named. Same class as the listings/offers detail-id fix; both
// ids now read through wholeNumber and are refused by name.
//
// Killing mutations: revert either call in the attestation / read_comment
// cases of src/mcp.ts back to Number() (the matching tests go red).

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
      VALUES (1, 'issuer', 'test-model', 'h1', 100, 100),
             (2, 'subject', 'test-model', 'h2', 100, 100);
    INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at)
      VALUES (1, 'correction', 1, 2, 'one', '[]', '{}', 'hash-1', 100),
             (2, 'correction', 1, 2, 'two', '[]', '{}', 'hash-2', 200);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (1, 1, 'post one', 'body', NULL, 'd1', NULL, 150);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (10, 1, NULL, 2, 'comment ten', 0, NULL, 160),
             (11, 1, NULL, 2, 'comment eleven', 0, NULL, 170);
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

const attId = (p: any) => (p?.attestation ?? p)?.id;
const cmtId = (p: any) => (p?.comment ?? p)?.id;

test("canonical attestation id and comment_id still work and match the HTTP detail row", async () => {
  const e = seeded();
  const httpAtt = await call(e, "/api/attestations/2");
  assert.equal(httpAtt.status, 200, JSON.stringify(httpAtt.body).slice(0, 200));
  for (const ok of [2, "2"]) {
    const door = await mcp(e, "attestation", { id: ok });
    assert.equal(door.isError, false, door.text.slice(0, 200));
    assert.equal(attId(door.parsed), attId(httpAtt.body));
  }
  const httpCmt = await call(e, "/api/comment/11");
  assert.equal(httpCmt.status, 200, JSON.stringify(httpCmt.body).slice(0, 200));
  for (const ok of [11, "11"]) {
    const door = await mcp(e, "read_comment", { comment_id: ok });
    assert.equal(door.isError, false, door.text.slice(0, 200));
    assert.equal(cmtId(door.parsed), cmtId(httpCmt.body));
  }
});

test("the HTTP detail doors refuse the non-canonical spellings this file sends over MCP", async () => {
  const e = seeded();
  for (const p of [
    "/api/attestations/2.0",
    "/api/attestations/0x2",
    "/api/attestations/2e0",
    "/api/comment/11.0",
    "/api/comment/0xb",
  ]) {
    assert.equal((await call(e, p)).status, 404, p);
  }
});

const ATT_BAD: unknown[] = [true, false, [2], { id: 2 }, "", " 2", "2.0", "0x2", "2e0", 2.5, -2, "two"];
const CMT_BAD: unknown[] = [true, false, [11], { id: 11 }, "", " 11", "11.0", "0xb", "1.1e1", 11.5, -11, "eleven"];

for (const bad of ATT_BAD) {
  test(`attestation id ${JSON.stringify(bad)} is refused by name, not coerced into a row`, async () => {
    const door = await mcp(seeded(), "attestation", { id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /\bid\b/);
  });
}

for (const bad of CMT_BAD) {
  test(`read_comment comment_id ${JSON.stringify(bad)} is refused by name, not coerced into a row`, async () => {
    const door = await mcp(seeded(), "read_comment", { comment_id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /comment_id/);
  });
}
