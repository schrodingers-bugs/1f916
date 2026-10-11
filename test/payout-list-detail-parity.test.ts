// Second read of WQ-328 (e585da550): the single-row GET /api/payout-bindings/:id now
// serves a flat receipt_id "matching the list route", but the upstream test checks
// the flat id only against the route's OWN nested receipt. Nothing pins the claim
// the commit actually makes: that a reader keyed on GET /api/payouts reads the same
// settlement fields under the same keys and values on the single-row route.
//
// This test walks every seeded binding (receipt-settled, observed-settled,
// unsettled, both) through listPayouts and getPayoutBinding and requires the
// settlement fields to agree key for key: receipt_id, settled_by,
// observed_transfer_id, observed_tx_hash, observed_block_number.
//
// Baseline on upstream e585da550: red on binding 4 (receipt AND a settling observed
// transfer). The list route spread its LEFT JOIN, serving settled_by:'receipt' beside
// observed_transfer_id 2, while the single-row route gates observed_* on settled_by and
// serves null; schemas/payouts.json's own prose says "null for a receipted binding".
// listPayouts now applies the same gate, and the schema's settled_by:'receipt' arm
// requires the observed_* trio null.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPayoutBinding, listPayouts, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";


const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function bindRow(id: number, docket: string): string {
  // Column order matches schema.sql payout_bindings; wallet_signature set,
  // wallet_proof_id null (the one-proof CHECK). expiry far in the future.
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'self', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // node:sqlite enforces foreign keys; D1 does not. A settled_award_id pointing at
  // an award row we did not seed is exactly what production allows (getPayoutBinding
  // joins observed_transfers, not listing_awards).
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
    ) VALUES ${bindRow(1, "listing-90")}, ${bindRow(2, "listing-91")}, ${bindRow(3, "listing-92")}, ${bindRow(4, "listing-93")};
    -- Binding 1: settled by a payout receipt (all fields CHECK-valid).
    INSERT INTO payout_receipts (
      binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender,
      block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording,
      funding_relationship, submitted_by, funder_address, funder_statement, funder_signature,
      funder_attestation_hash, payload_hash, checked_at, created_at
    ) VALUES (
      1, 1, '0x${"1".repeat(64)}', 0, '0x${"a".repeat(40)}', '0x${"b".repeat(40)}',
      100, '0x${"c".repeat(64)}', 100, 100, 12,
      'independent', 'payee', '0x${"a".repeat(40)}', '1f916.payout-funder.v1:x', '0x${"d".repeat(130)}',
      '${"e".repeat(64)}', 'rph-1', 100, 100
    );
    -- Binding 2: settled by an observed transfer (settled_award_id set), no receipt.
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx', 0, 51480102, 'payment', 2, 91, 1, 2, 100, 11, 100, 100);
    -- Binding 3: unsettled (no receipt, no settling transfer).
    -- Binding 4: BOTH a receipt AND a settling observed transfer. createPayoutReceipt
    -- does not read observed_transfers, so a receipt filed after an on-chain
    -- settlement produces this state in production. settled_by must be the single
    -- source of truth (receipt wins) and the observed_* trio must be null, so the
    -- schema's "null otherwise" holds.
    INSERT INTO payout_receipts (
      binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender,
      block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording,
      funding_relationship, submitted_by, funder_address, funder_statement, funder_signature,
      funder_attestation_hash, payload_hash, checked_at, created_at
    ) VALUES (
      4, 1, '0x${"2".repeat(64)}', 0, '0x${"a".repeat(40)}', '0x${"b".repeat(40)}',
      100, '0x${"c".repeat(64)}', 100, 100, 12,
      'independent', 'payee', '0x${"a".repeat(40)}', '1f916.payout-funder.v1:y', '0x${"d".repeat(130)}',
      '${"f".repeat(64)}', 'rph-4', 100, 100
    );
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx4', 0, 51480200, 'payment', 4, 93, 1, 2, 100, 12, 100, 100);
  `);
  return env;
}

const SETTLEMENT_KEYS = ["receipt_id", "settled_by", "observed_transfer_id", "observed_tx_hash", "observed_block_number"] as const;

test("GET /api/payouts and GET /api/payout-bindings/:id agree on every settlement field, for every settlement regime (WQ-328 parity)", async () => {
  const env = seeded();
  const list = await listPayouts(env, null) as { bindings: Record<string, unknown>[] };
  assert.equal(list.bindings.length, 4, "all four seeded bindings are on the list page");
  const regimes = new Set<unknown>();
  for (const row of list.bindings) {
    const detail = await getPayoutBinding(env, Number(row.id)) as Record<string, unknown>;
    for (const key of SETTLEMENT_KEYS) {
      assert.ok(key in row, `list row ${row.id} serves ${key}`);
      assert.ok(key in detail, `detail ${row.id} serves ${key}`);
      assert.deepEqual(detail[key], row[key], `binding ${row.id}: ${key} on /api/payout-bindings/:id equals /api/payouts`);
    }
    regimes.add(row.settled_by);
  }
  assert.deepEqual([...regimes].sort(), ["observed_transfer", "receipt", null].sort(), "the fixture exercises all three settled_by values");
});

test("the receipt-settled binding's flat receipt_id is non-null on both routes (a both-null agreement proves nothing)", async () => {
  const env = seeded();
  const list = await listPayouts(env, null) as { bindings: Record<string, unknown>[] };
  const receipted = list.bindings.filter((r) => r.receipt_id !== null);
  assert.ok(receipted.length >= 1);
  for (const row of receipted) {
    const detail = await getPayoutBinding(env, Number(row.id)) as Record<string, unknown>;
    assert.equal(typeof detail.receipt_id, "number");
    assert.equal(detail.receipt_id, row.receipt_id);
  }
  const observed = list.bindings.filter((r) => r.observed_transfer_id !== null);
  assert.ok(observed.length >= 1, "an observed-settled binding is present, so observed_* parity is not vacuous");
});

test("schemas/payouts.json: a settled_by:'receipt' row with a non-null observed_* field is refused; the served rows validate", async () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/payouts.json", import.meta.url)), "utf8"));
  const binding = schema.$defs.binding;
  const env = seeded();
  const list = await listPayouts(env, null) as { bindings: Record<string, unknown>[] };
  // The sqlite fixture's placeholder hashes and docket snapshots are not schema-shaped;
  // only the settlement fields are under test, so filter to errors that name them.
  const settlementErrors = (v: unknown) => validate(binding, v, "$", schema).filter((e: string) => /observed_|receipt_id|settled_by/.test(e));
  for (const row of list.bindings) assert.deepEqual(settlementErrors(row), [], `served list row ${row.id} has no settlement-field schema error`);
  const both = list.bindings.find((r) => r.settled_by === "receipt" && Number(r.id) === 4)!;
  for (const [key, value] of [["observed_transfer_id", 2], ["observed_tx_hash", "0xobservedtx"], ["observed_block_number", 51480102]] as const) {
    const leaked = { ...both, [key]: value };
    assert.ok(settlementErrors(leaked).some((e: string) => e.includes(key)), `${key} non-null under settled_by:'receipt' is a schema error`);
  }
});
