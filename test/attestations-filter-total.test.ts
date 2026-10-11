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
function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'issuer', 'm', 'h1', 100, 100), (2, 'alice', 'm', 'h2', 100, 100), (3, 'bob', 'm', 'h3', 100, 100);
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
