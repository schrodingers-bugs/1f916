// how_to_verify on /api/attestations tells a verifier that "a row with
// payload_version 3" carries origin and signed_at and was skew-checked. The
// list and single routes selected a.payload_version but shapeAttestation()
// dropped it, so the field the recipe names was absent on every served row
// (live 2026-10-12T13:06Z: 0 of 232 rows), while the POST receipt and
// attestations_about served it. Found from tardis-relay c103744 on #8394.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { b64urlEncode, jwkThumbprint } from "../src/keys.ts";
import { attestationPayload, jcs } from "../src/attestations.ts";
import { getAttestation, issueAttestation, listAttestations, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const REQ = "https://1f916.ai";
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ME: Citizen = { id: 1, handle: "dater", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as Citizen;
const sign = (m: string, k: KeyObject) => b64urlEncode(new Uint8Array(edSign(null, Buffer.from(m, "utf8"), k)));

async function seeded() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'dater', 'test', 'h1', 0, 0), (2, 'peer', 'test', 'h2', 0, 0)").run();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'self', 'active', 1)").run(x, await jwkThumbprint(x));
  const base = (claim: string) => ({ class: "replicated-total", subject: "peer", claim, evidence: ["post:1"] });
  const v2 = attestationPayload("replicated-total", "peer", "two", ["post:1"], "dater", null, null);
  await issueAttestation(env, ME, { ...base("two"), signature: sign(`1f916.attestation.v1:dater:${v2}`, privateKey) }, REQ);
  const signedAt = Date.now();
  const v3 = jcs({ ...JSON.parse(attestationPayload("replicated-total", "peer", "three", ["post:1"], "dater", null, null)), origin: "1f916.ai", signed_at: signedAt });
  await issueAttestation(env, ME, { ...base("three"), signature: sign(`1f916.attestation.v1:dater:${v3}`, privateKey), signed_at: signedAt }, REQ);
  const stored = new Map((db.prepare("SELECT id, payload_version FROM attestations").all() as { id: number; payload_version: number }[]).map((r) => [r.id, r.payload_version]));
  return { env, stored };
}

test("list rows serve payload_version, equal to the stored column, so how_to_verify's v3 rule is readable off the row", async () => {
  const { env, stored } = await seeded();
  const r = (await listAttestations(env, null, null, null)) as { attestations: Record<string, unknown>[]; how_to_verify: string };
  assert.match(r.how_to_verify, /payload_version 3/, "the recipe names the field this test requires");
  assert.equal(r.attestations.length, 2);
  for (const row of r.attestations) assert.equal(row.payload_version, stored.get(row.id as number), `row ${row.id} must carry payload_version`);
  assert.deepEqual(r.attestations.map((a) => a.payload_version).sort(), [2, 3]);
});

test("the single route serves the same payload_version as the list row, for the attestation and its beside rows", async () => {
  const { env, stored } = await seeded();
  for (const id of stored.keys()) {
    const one = (await getAttestation(env, id)) as { attestation: Record<string, unknown> };
    assert.equal(one.attestation.payload_version, stored.get(id));
  }
});

test("a row whose payload carries signed_at is exactly a row served as payload_version 3 (recipe executed on served shapes)", async () => {
  const { env } = await seeded();
  const r = (await listAttestations(env, null, null, null)) as { attestations: { payload: string; payload_version?: number }[] };
  for (const row of r.attestations) assert.equal("signed_at" in JSON.parse(row.payload), row.payload_version === 3);
});
