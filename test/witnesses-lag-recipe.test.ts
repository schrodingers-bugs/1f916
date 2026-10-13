// countersigned_note told a reader to recompute lag_s "from GET /api/checkpoint:
// find the first checkpoint of that log past the row's tree_size". That door
// takes no parameters and serves only each log's newest head, so for a row two
// stamps behind the recipe finds the newest stamp, not the first one past the
// row, and a witness hours behind recomputes as minutes behind (live 2026-10-13
// 03:06Z: GET /api/checkpoint serves identity_events 26361 only, while the
// stamps at 26286 and 26326 that /api/proof names sit between). The no-note 404
// on GET /api/checkpoint/note/:log?tree_size= said the same of an earlier stamp
// ("the stamp itself is at GET /api/checkpoint"; live: ledger tree_size=10 has
// no note and GET /api/checkpoint serves ledger 11).
//
// These tests EXECUTE the recipe the served prose gives, through the doors it
// names, against a log with three stamps past nothing and a row pushed at the
// first, and compare with the lag_s the directory serves. No regex on the
// sentence decides them.
//
// Killing mutations: drop lag_from (or key it off the newest stamp), point the
// note's recipe back at GET /api/checkpoint, or point noNoteSentence back at the
// latest-only door, and the matching test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import { listWitnesses, sealMemory, type Env, type Citizen } from "../src/society.ts";
import { checkpointNote, noNoteSentence } from "../src/checkpoint.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const DIRECTORY_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/witnesses.json", import.meta.url)), "utf8"));
const ROOT = "a".repeat(64);
const SIG = "b".repeat(86);

// The checkpoint doors read the registry key; a throwaway one, as in note.test.ts.
function registrySeed() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return `${Buffer.from(seed).toString("base64url")}.${Buffer.from(pub).toString("base64url")}`;
}

async function fixture(now: number) {
  const { env: base, db } = sqliteTestEnv(SCHEMA);
  const env = { ...base, REGISTRY_SEED: registrySeed() } as Env;
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test', 'h1', 0, 0)");
  db.exec("INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (1, 1, 'w1', 'https://example.test/w1/', NULL, 0, 0, 0)");
  const e = env;
  const keeper = { id: 1, handle: "keeper" } as Citizen;
  for (let i = 0; i < 7; i++) await sealMemory(e, keeper, { hash: Buffer.from(`lag-${i}`.padEnd(32, ".")).toString("hex"), label: `lag${i}` });
  // Three stamps of identity_events: the row is pushed at the first; lag_s
  // counts from the second (the oldest past the row), not the third (newest).
  const stamp = db.prepare("INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (?, 'identity_events', ?, ?, ?, ?)");
  stamp.run(1, 5, ROOT, SIG, now - 500_000);
  stamp.run(2, 6, ROOT, SIG, now - 90_500);
  stamp.run(3, 7, ROOT, SIG, now - 10_000);
  db.prepare(
    "INSERT INTO witness_countersignatures (witness_id, log, tree_size, root, witness_sig, witness_epoch, checkpoint_id, received_at, receipt_payload, receipt_sig) VALUES (1, 'identity_events', 5, ?, ?, 0, 1, ?, 'p', ?)",
  ).run(ROOT, SIG, now - 1000, SIG);
  return { env: e, db };
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`https://1f916.ai${path}`), env);
  return { status: res.status, body: (await res.json()) as any };
}

test("the countersigned_note recipe, executed through the door it names, recomputes the served lag_s", async (t) => {
  const NOW = Date.now();
  const { env, db } = await fixture(NOW);
  t.after(() => db.close());
  const dir: any = await listWitnesses(env, NOW);
  const entry = dir.witnesses[0].countersigned.identity_events;
  assert.equal(entry.lag_s, 90, "control: the directory counts from tree_size 6");
  assert.deepEqual(validate(DIRECTORY_SCHEMA, { now: NOW, now_utc: new Date(NOW).toISOString(), ...dir }), [], "the served directory, lag_from included, is the published schema");

  // The latest-only door: what the old recipe read. It serves tree_size 7, so
  // the old recipe gave 10, not 90. The note must not send a reader there for this.
  const latest = await get(env, "/api/checkpoint");
  const head = latest.body.checkpoints.find((c: any) => c.log === "identity_events");
  assert.equal(head.tree_size, 7, "GET /api/checkpoint serves the newest head only");
  assert.notEqual(Math.floor((NOW - head.created_at) / 1000), entry.lag_s, "reading the newest head is the wrong recipe");
  assert.doesNotMatch(dir.countersigned_note, /Recompute it from GET \/api\/checkpoint\b(?!\/)/, "the recipe does not name the latest-only door");

  // The entry names the stamp it counts from, and the note's door serves it.
  assert.deepEqual(entry.lag_from, { tree_size: 6, created_at: NOW - 90_500 });
  assert.match(dir.countersigned_note, /GET \/api\/checkpoint\/consistency\?log=<log>&from=<tree_size>&to=<lag_from\.tree_size>/);
  const door = await get(env, `/api/checkpoint/consistency?log=identity_events&from=${entry.tree_size}&to=${entry.lag_from.tree_size}`);
  assert.equal(door.status, 200);
  assert.equal(door.body.to.tree_size, entry.lag_from.tree_size);
  assert.equal(Math.floor((NOW - door.body.to.created_at) / 1000), entry.lag_s, "the recipe, executed, gives the served lag_s");
  // No stamp lands between the row and lag_from: the same door refuses every size in between (here none), and answers at lag_from.
  for (let size = entry.tree_size + 1; size < entry.lag_from.tree_size; size++)
    assert.equal((await get(env, `/api/checkpoint/consistency?log=identity_events&from=${entry.tree_size}&to=${size}`)).status, 404);
});

test("a row on the newest stamp serves lag_s 0 with lag_from null", async (t) => {
  const NOW = Date.now();
  const { env, db } = await fixture(NOW);
  t.after(() => db.close());
  db.prepare("UPDATE witness_countersignatures SET tree_size = 7, checkpoint_id = 3").run();
  const dir: any = await listWitnesses(env, NOW);
  const entry = dir.witnesses[0].countersigned.identity_events;
  assert.equal(entry.lag_s, 0);
  assert.equal(entry.lag_from, null, "no stamp past the row: nothing to count from, and null, not absent");
  assert.deepEqual(validate(DIRECTORY_SCHEMA, { now: NOW, now_utc: new Date(NOW).toISOString(), ...dir }), []);
});

test("the no-note 404 for an earlier stamp names a door that serves that stamp", async (t) => {
  const NOW = Date.now();
  const { env, db } = await fixture(NOW);
  t.after(() => db.close());
  // tree_size 5 has no note and is not the newest stamp.
  await assert.rejects(checkpointNote(env, "identity_events", 5), (e: unknown) => (e as Error).message === noNoteSentence("identity_events", 5));
  const sentence = noNoteSentence("identity_events", 5);
  const m = sentence.match(/GET (\/api\/checkpoint\S*)/);
  assert.ok(m, "the sentence names a door");
  const door = await get(env, m![1]);
  assert.equal(door.status, 200, `the named door answers: ${m![1]}`);
  const served = [door.body.to, door.body.from, ...(door.body.checkpoints ?? [])].filter(Boolean);
  assert.ok(served.some((c: any) => c.tree_size === 5 && c.created_at === NOW - 500_000), "the named door serves the stamp at tree_size 5, with its created_at");
});
