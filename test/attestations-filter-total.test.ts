// /api/attestations serves `total`: the row count under the same subject=,
// issuer= and class= filter, ignoring since_id. Before it, a filtered walker
// had no population to check its walk against: count is one page,
// totals_by_kind.attestation on /api/events is every attestation unfiltered,
// so "did I collect them all for subject X?" had no served answer (the
// attestations-per-filter gap from posts 8394 / 7536). Same rule as
// /api/seals total: the same number on every page of a walk.
//
// Killing mutations: count under the cursor predicate (total shrinks on page
// 2); count unfiltered (total ignores subject/class); drop the field.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
// 205 corrections about alice (past one 200-row page), 3 disputes about alice,
// 4 corrections about bob. 212 rows in all.
function seeded(carol = 0): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'issuer', 'm', 'h1', 100, 100), (2, 'alice', 'm', 'h2', 100, 100), (3, 'bob', 'm', 'h3', 100, 100), (4, 'carol', 'm', 'h4', 100, 100);
  `);
  const ins = db.prepare(
    "INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES (?, ?, 1, ?, 'c', '[]', '{}', ?, ?)",
  );
  let id = 0;
  const add = (cls: string, subject: number, n: number) => {
    for (let k = 0; k < n; k++) { id++; ins.run(id, cls, subject, `h-${id}`, 100 + id); }
  };
  add("correction", 2, 205);
  add("dispute", 2, 3);
  add("correction", 3, 4);
  add("correction", 4, carol);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  assert.equal(res.status, 200, path);
  return (await res.json()) as { count: number; total: number; has_more: boolean; next_since_id?: number; attestations: unknown[] };
}

test("total follows the filter, not the page and not the whole table", async () => {
  const env = seeded();
  assert.equal((await get(env, "/api/attestations")).total, 212);
  assert.equal((await get(env, "/api/attestations?subject=alice")).total, 208);
  assert.equal((await get(env, "/api/attestations?subject=bob")).total, 4);
  assert.equal((await get(env, "/api/attestations?subject=alice&class=dispute")).total, 3);
  assert.equal((await get(env, "/api/attestations?issuer=nobody")).total, 0);
});

test("total is the same on every page, and a filtered walk ends at exactly total rows", async () => {
  const env = seeded();
  let path = "/api/attestations?subject=alice";
  let collected = 0;
  const totals = new Set<number>();
  for (let pages = 0; pages < 5; pages++) {
    const body = await get(env, path);
    collected += body.attestations.length;
    totals.add(body.total);
    if (!body.has_more) break;
    path = `/api/attestations?subject=alice&since_id=${body.next_since_id}`;
  }
  assert.deepEqual([...totals], [208]);
  assert.equal(collected, 208);
});

test("schemas/attestations.json describes total", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/attestations.json", import.meta.url)), "utf8"));
  assert.equal(schema.properties.total?.type, "integer");
  assert.match(schema.properties.total.description, /ignoring since_id/);
});

// Boundary fixtures (acceptance from c102407): a filter that matches nothing,
// and a filter that matches exactly one page. Off-by-one in has_more or a
// page-scoped total shows up at exactly these two edges.
test("0-match filter: total 0, count 0, has_more false, no cursor", async () => {
  const env = seeded();
  for (const q of ["subject=carol", "issuer=alice", "subject=bob&class=dispute"]) {
    const body = await get(env, `/api/attestations?${q}`);
    assert.equal(body.total, 0, q);
    assert.equal(body.count, 0, q);
    assert.equal(body.attestations.length, 0, q);
    assert.equal(body.has_more, false, q);
    assert.equal(body.next_since_id ?? null, null, q);
  }
});

test("exactly one full page under the filter: total == count == 200, has_more false", async () => {
  const env = seeded(200);
  const body = await get(env, "/api/attestations?subject=carol");
  assert.equal(body.attestations.length, 200);
  assert.equal(body.total, 200);
  assert.ok(body.total >= body.count);
  assert.equal(body.has_more, false, "no rows remain after the last one served");
  // one more row under the filter tips it over: has_more true, total 201 on both pages
  const env2 = seeded(201);
  const p1 = await get(env2, "/api/attestations?subject=carol");
  assert.equal(p1.has_more, true);
  assert.equal(p1.total, 201);
  const p2 = await get(env2, `/api/attestations?subject=carol&since_id=${p1.next_since_id}`);
  assert.equal(p2.attestations.length, 1);
  assert.equal(p2.total, 201);
  assert.equal(p2.has_more, false);
});
