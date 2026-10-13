// MCP `listings` and `offers` read one row's id with the same rule as the HTTP door.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// GET /api/listings/:id and GET /api/offers/:id only route a run of digits
// (the \d+ path match). The MCP `listings` and `offers` tools ran Number()
// over whatever JSON arrived, so listing_id:true served listing 1,
// listing_id:[2] / " 2" / "2.0" / "0x2" / "2e0" served listing 2, and
// offer_id did the same for offers. Live 2026-10-13T01:14Z on 5c2cff2ea:
// tools/call listings {"listing_id":true} -> listing-1, {"listing_id":[57]}
// / " 57" / "57.0" / "0x39" / "5.7e1" -> listing-57, offers {"offer_id":true}
// / [1] -> offer-1, while /api/listings/57.0 and /api/listings/0x39 are 404.
// On a money-rail read a coerced id is a priced row nobody named, served as
// if it had been asked for. Same class as the payouts binding_id fix; the
// listings tool already reads since_id through wholeNumber, so the id now
// reads through it too and is refused by name.
//
// Killing mutations: revert either detail-id call in the listings / offers
// cases of src/mcp.ts back to Number() (the matching tests go red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const COND = "Deliver a working patch with a test that fails before and passes after the change.";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("PRAGMA foreign_keys = OFF");
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'funder', 'test-model', 'h1', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
      VALUES (1, 1, 'listing one', '${COND}', '1000000', 8453, '${TOKEN}', ${exp}, 'lph1', 'ln1', 200),
             (2, 1, 'listing two', '${COND}', '2000000', 8453, '${TOKEN}', ${exp}, 'lph2', 'ln2', 200);
    INSERT INTO offers (id, citizen_id, title, terms, amount_atomic, chain_id, token, delivery_window_seconds, expiry, payload_hash, commit_nonce, created_at)
      VALUES (1, 1, 'offer one', '${COND}', '1000000', 8453, '${TOKEN}', 86400, ${exp}, 'oph1', 'on1', 200),
             (2, 1, 'offer two', '${COND}', '2000000', 8453, '${TOKEN}', 86400, ${exp}, 'oph2', 'on2', 200);
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

const rowId = (p: any, key: "listing" | "offer") => (p?.[key] ?? p)?.id;

test("canonical listing_id and offer_id still work and match the HTTP detail row", async () => {
  const e = seeded();
  for (const [tool, arg, key, path] of [
    ["listings", "listing_id", "listing", "/api/listings/2"],
    ["offers", "offer_id", "offer", "/api/offers/2"],
  ] as const) {
    const http = await call(e, path);
    assert.equal(http.status, 200, JSON.stringify(http.body).slice(0, 200));
    for (const ok of [2, "2"]) {
      const door = await mcp(e, tool, { [arg]: ok });
      assert.equal(door.isError, false, door.text.slice(0, 200));
      assert.equal(rowId(door.parsed, key), rowId(http.body, key));
    }
  }
});

test("the HTTP detail doors refuse the non-canonical spellings this file sends over MCP", async () => {
  const e = seeded();
  for (const p of ["/api/listings/2.0", "/api/listings/0x2", "/api/listings/2e0", "/api/offers/2.0", "/api/offers/0x2"]) {
    assert.equal((await call(e, p)).status, 404, p);
  }
});

const BAD: unknown[] = [true, false, [2], { id: 2 }, "", " 2", "2.0", "0x2", "2e0", 2.5, -2, "two"];

for (const [tool, arg] of [["listings", "listing_id"], ["offers", "offer_id"]] as const) {
  for (const bad of BAD) {
    test(`${tool} ${arg} ${JSON.stringify(bad)} is refused by name, not coerced into a row`, async () => {
      const door = await mcp(seeded(), tool, { [arg]: bad });
      assert.equal(door.isError, true, `served ${door.text.slice(0, 120)}`);
      assert.match(door.text, new RegExp(arg));
    });
  }
}
