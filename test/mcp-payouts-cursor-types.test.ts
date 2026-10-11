// MCP `payouts` reads its cursor and row id with the same rule as the HTTP door.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/payouts?since_id= and GET /api/payout-bindings/:id only accept a
// canonical decimal (wholeNumberParam / the \d+ route). The MCP `payouts` tool
// ran Number() over whatever JSON arrived: since_id:true resumed after binding 1,
// since_id:[2] after binding 2, since_id:"" served the whole page from 0, and
// binding_id:true / [3] / " 3" returned that binding's full canonical record.
// Each is a request the HTTP door refuses, answered silently on /mcp with a
// different page or a different row than nothing-at-all. On a money-rail read
// a coerced row id is the wrong payee record served as if asked for.
//
// Killing mutations: revert either wholeNumber call in the payouts case of
// src/mcp.ts back to Number() (the matching test goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function bindRow(id: number): string {
  return `(${id}, 1, 'listing-${90 + id}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'self', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'payee', 'test-model', 'h1', 100, 100);
    INSERT INTO payout_bindings (
      id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
      wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint,
      citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at,
      docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash,
      commit_nonce, created_at
    ) VALUES ${bindRow(1)}, ${bindRow(2)}, ${bindRow(3)};
  `);
  return env;
}

async function call(e: Env, path: string, init?: RequestInit) {
  const r = await worker.fetch(new Request(`https://1f916.ai${path}`, init), e);
  return { status: r.status, body: (await r.json()) as any };
}

async function mcp(e: Env, args: Record<string, unknown>) {
  const { body } = await call(e, "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payouts", arguments: args } }),
  });
  const text = body.result?.content?.[0]?.text ?? JSON.stringify(body.error ?? {});
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* error prose */ }
  return { isError: body.result?.isError === true || body.error != null, text, parsed };
}

const ids = (page: any) => (page?.bindings ?? []).map((b: any) => b.id);

test("canonical cursors and ids still work and match HTTP", async () => {
  const e = seeded();
  const http = await call(e, "/api/payouts?since_id=1");
  const door = await mcp(e, { since_id: 1 });
  assert.equal(door.isError, false, door.text);
  assert.deepEqual(ids(door.parsed), ids(http.body));
  assert.deepEqual(ids(door.parsed), [2, 3]);
  assert.deepEqual(ids((await mcp(e, { since_id: "2" })).parsed), [3]);
  const one = await mcp(e, { binding_id: 3 });
  assert.equal(one.isError, false, one.text);
  assert.equal((one.parsed.binding ?? one.parsed).id ?? one.parsed.id, 3);
  assert.equal((await mcp(e, { binding_id: "3" })).isError, false);
});

for (const bad of [true, false, [2], { n: 2 }, "", " 2", "2.0", "1e0", 1.5, -1, "two"]) {
  test(`since_id ${JSON.stringify(bad)} is refused by name, as HTTP refuses it`, async () => {
    const door = await mcp(seeded(), { since_id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /since_id/);
  });
}

for (const bad of [true, [3], { id: 3 }, " 3", "3.0", 3.5, "three"]) {
  test(`binding_id ${JSON.stringify(bad)} is refused by name, not coerced into a row`, async () => {
    const door = await mcp(seeded(), { binding_id: bad });
    assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
    assert.match(door.text, /binding_id/);
  });
}
