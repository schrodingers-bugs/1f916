import test from "node:test";
import assert from "node:assert/strict";
import { listingClockPreview } from "../src/listing-clock-preview.ts";
import { validateSettlement } from "../src/settlement.ts";
import { SocietyError } from "../src/society.ts";

// The preview is observe-only, but it must never answer a clock combination
// that POST /api/listings refuses with a quiet or merely-advisory preview.
// Each case: same proposed clocks into the preview and into POST's validator.
const now = Math.floor(Date.now() / 1000);
const expiry = now + 14 * 86400;

function postError(body: Record<string, unknown>): string | null {
  try { validateSettlement({ max_awards: 1, ...body }, expiry); return null; }
  catch (e) { assert.ok(e instanceof SocietyError); return (e as Error).message; }
}
function previewError(q: Record<string, string>): string | null {
  try { listingClockPreview(q, expiry); return null; }
  catch (e) { assert.ok(e instanceof SocietyError); assert.equal((e as SocietyError).status, 400); return (e as Error).message; }
}

const refused: [string, Record<string, string>, Record<string, unknown>, RegExp][] = [
  ["deadline after expiry", { submission_deadline: String(expiry + 100) }, { submission_deadline: expiry + 100 }, /after the listing's own expiry/],
  ["deadline in 1970", { submission_deadline: "1000" }, { submission_deadline: 1000 }, /in the future/],
  ["deadline exactly now-ish past", { submission_deadline: String(now - 1) }, { submission_deadline: now - 1 }, /in the future/],
  ["timeout on automatic", { settlement_mode: "automatic", requester_timeout_seconds: "3600" }, { settlement_mode: "verifier", requester_timeout_seconds: 3600 }, /only meaningful with settlement_mode requester/],
  ["timeout on verifier", { settlement_mode: "verifier", requester_timeout_seconds: "3600" }, { settlement_mode: "verifier", requester_timeout_seconds: 3600 }, /only meaningful with settlement_mode requester/],
];

for (const [name, q, body, why] of refused) {
  test(`POST refuses and the preview refuses by name too: ${name}`, () => {
    const post = postError(body);
    assert.ok(post, `POST should refuse ${name}`);
    assert.match(post!, why);
    const prev = previewError(q);
    assert.ok(prev, `preview served a preview for ${name} that POST refuses: ${JSON.stringify(q)}`);
    assert.match(prev!, why);
  });
}

test("edges POST accepts stay previewable: deadline == expiry, deadline one second ahead", () => {
  for (const d of [expiry, now + 60]) {
    assert.equal(postError({ submission_deadline: d }), null);
    const p = listingClockPreview({ submission_deadline: String(d) }, expiry);
    assert.equal(p.decision_room_seconds, expiry - d);
    assert.ok(p.decision_room_seconds! >= 0, "decision room is never negative on a previewable listing");
  }
});
