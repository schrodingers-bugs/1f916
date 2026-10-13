// MCP `witness_history` id and `grants` proposal_id read one row's id with
// the same rule as the HTTP detail doors.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/witnesses/:id/history routes only [0-9]{1,9} and
// GET /api/grants/:slug/proposals/:id only \d+. The MCP `witness_history`
// tool ran Number() over whatever JSON arrived and then range-checked the
// result, which cannot tell id:true from 1 or "0x3" from 3; `grants` ran
// Number() over proposal_id with no check at all. Live 2026-10-13T05:09Z on
// ca353d546: tools/call witness_history {"id":true} / [1] / "1.0" / "0x1" /
// " 1" / "1e0" -> witness 1, {"id":[3]} / "3.0" / "0x3" -> witness 3 (the
// one with a register row); grants {"slug":"1f512","proposal_id":true} /
// [1] / "1.0" / "0x1" -> proposal 1; while /api/witnesses/1.0/history,
// /0x1/history, /%201/history, /1e0/history, /3.0/history and
// /api/grants/1f512/proposals/1.0, /0x1 are all 404. Both are
// unauthenticated reads that answer for a row nobody named. Same class as
// the listings/offers and attestation/read_comment detail-id fixes; both
// ids now read through wholeNumber and are refused by name.
//
// Killing mutations: revert either call in the witness_history / grants
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
  const now = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'operator', 'test-model', 'h1', 100, 100),
             (2, 'proposer', 'test-model', 'h2', 100, 100);
    INSERT INTO witnesses (id, citizen_id, name, url, public_key, added_at, epoch, key_set_at)
      VALUES (1, 1, 'witness one', 'https://w1.example/countersignatures.jsonl', NULL, 100, 0, NULL),
             (3, 1, 'witness three', 'https://w3.example/countersignatures.jsonl', NULL, 300, 0, NULL);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (700, 2, 'grant thread', 'body', 'dh-700', ${now});
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
      VALUES (900, 700, NULL, 2, 'PROPOSAL 1: a thing', 0, ${now});
  `);
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, created_at, updated_at, transition_nonce) " +
      "VALUES (1, 'testgrant', 'Test Grant', 2, 'domain', 'test.com', 'confirmed', 'A brief that is comfortably longer than the forty characters this table requires of one.', 'vote', 'open', 700, ?, ?, 'n1')",
  ).run(now, now);
  db.prepare(
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, payload_hash, created_at) " +
      "VALUES (1, 1, 2, 'a thing worth doing', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 900, 'ph', ?)",
  ).run(now);
  return env as Env;
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

const stripClock = (b: any) => {
  if (!b || typeof b !== "object") return b;
  const { now: _n, now_utc: _u, ...rest } = b;
  return rest;
};

test("canonical witness id and proposal_id still work and serve the HTTP detail row", async () => {
  const e = seeded();
  const httpW = await call(e, "/api/witnesses/3/history");
  assert.equal(httpW.status, 200, JSON.stringify(httpW.body).slice(0, 200));
  for (const ok of [3, "3"]) {
    const door = await mcp(e, "witness_history", { id: ok });
    assert.equal(door.isError, false, door.text.slice(0, 200));
    assert.equal(door.parsed?.witness?.id, 3);
    assert.deepEqual(stripClock(door.parsed), stripClock(httpW.body));
  }
  const httpP = await call(e, "/api/grants/testgrant/proposals/1");
  assert.equal(httpP.status, 200, JSON.stringify(httpP.body).slice(0, 200));
  for (const ok of [1, "1"]) {
    const door = await mcp(e, "grants", { slug: "testgrant", proposal_id: ok });
    assert.equal(door.isError, false, door.text.slice(0, 200));
    assert.equal(door.parsed?.id, 1);
    assert.deepEqual(stripClock(door.parsed), stripClock(httpP.body));
  }
});

test("grants without proposal_id still reads the grant, and witness_history without id is still refused", async () => {
  const e = seeded();
  const grant = await mcp(e, "grants", { slug: "testgrant" });
  assert.equal(grant.isError, false, grant.text.slice(0, 200));
  const missing = await mcp(e, "witness_history", {});
  assert.equal(missing.isError, true, missing.text.slice(0, 200));
});

test("the HTTP detail doors refuse the non-canonical spellings this file sends over MCP", async () => {
  const e = seeded();
  for (const p of [
    "/api/witnesses/3.0/history",
    "/api/witnesses/0x3/history",
    "/api/witnesses/3e0/history",
    "/api/witnesses/%203/history",
    "/api/grants/testgrant/proposals/1.0",
    "/api/grants/testgrant/proposals/0x1",
    "/api/grants/testgrant/proposals/1e0",
  ]) {
    assert.equal((await call(e, p)).status, 404, p);
  }
});

const W_BAD: unknown[] = [true, false, [3], { id: 3 }, "", " 3", "3.0", "0x3", "3e0", 3.5, -3, "three"];
const P_BAD: unknown[] = [true, false, [1], { id: 1 }, "", " 1", "1.0", "0x1", "1e0", 1.5, -1, "one"];

for (const bad of W_BAD) {
  test(`witness_history id ${JSON.stringify(bad)} is refused, not coerced into a witness`, async () => {
    const door = await mcp(seeded(), "witness_history", { id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /\bid\b/);
  });
}

for (const bad of P_BAD) {
  test(`grants proposal_id ${JSON.stringify(bad)} is refused by name, not coerced into a proposal`, async () => {
    const door = await mcp(seeded(), "grants", { slug: "testgrant", proposal_id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /proposal_id/);
  });
}
